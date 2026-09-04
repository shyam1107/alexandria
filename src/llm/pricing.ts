import { Logger } from '@nestjs/common';

/**
 * The price table. Lives in CODE, not the database and not env: a price
 * change should be a diff with git history as the audit trail, not a
 * migration and not an ops setting nobody versions.
 *
 * Values are micro-USD per MILLION tokens, as bigint. Money is never a
 * float anywhere in the cost path (see the llm_usage_events schema comment).
 *
 * Cost is computed at call time and stored on the ledger row — never
 * recomputed from the current table. Vendors change prices; recomputing
 * history would rewrite the past.
 *
 * Prices verified against vendor pages 2026-08. They drift; update with a
 * commit, not silently.
 */
interface PriceEntry {
  promptMicroUsdPerMillion: bigint;
  completionMicroUsdPerMillion: bigint;
}

const MILLION = 1_000_000n;

const PRICES: Record<string, PriceEntry> = {
  // Ollama: self-hosted or flat cloud subscription — the marginal per-token
  // cost genuinely is $0. This zero is DECLARED, which is the only honest
  // kind: an unknown model must never read as $0 (see computeCostMicroUsd).
  'ollama/gpt-oss:120b': { promptMicroUsdPerMillion: 0n, completionMicroUsdPerMillion: 0n },
  'ollama/nomic-embed-text': { promptMicroUsdPerMillion: 0n, completionMicroUsdPerMillion: 0n },
  // The embedding model since Phase 7b. Same declared-zero class as above —
  // but the entry is load-bearing for the quota counter, not just the
  // ledger: usage-ledger.ts increments the Redis counter only when cost is
  // non-null, so a missing entry makes every embedding call invisible to
  // QuotaGuard. Today local Ollama is free, but EMBEDDING_BASE_URL can point
  // at a metered host (OLLAMA_API_KEY exists for exactly that), and on that
  // day embedding spend is unbounded and outside the cap.
  'ollama/snowflake-arctic-embed:110m': { promptMicroUsdPerMillion: 0n, completionMicroUsdPerMillion: 0n },
  // Gemini paid-tier standard rates, verified against ai.google.dev/gemini-api/docs/pricing
  // on 2026-08-30. gemini-2.0-flash is GONE — the live API returns 404 with
  // "no longer available" — so its entry is removed rather than left to rot:
  // a price for a model that cannot be called is worse than no price, because
  // the fail-closed boot check would happily approve it.
  //
  // NOTE for whoever reads this in 2027: gemini-3.6-flash is $0.75/$3.75
  // only THROUGH 2026-12-31, then doubles to $1.50/$7.50. A dated price in a
  // static table is a diff someone must remember to make; the alternative
  // (fetching live prices) makes billing depend on a network call.
  'gemini/gemini-3.1-flash-lite': { promptMicroUsdPerMillion: 250_000n, completionMicroUsdPerMillion: 1_500_000n },
  'gemini/gemini-2.5-flash': { promptMicroUsdPerMillion: 300_000n, completionMicroUsdPerMillion: 2_500_000n },
  'gemini/gemini-3.6-flash': { promptMicroUsdPerMillion: 750_000n, completionMicroUsdPerMillion: 3_750_000n },
  // The test double: declared zero so pipeline tests exercising the real
  // ledger see a real (free) price, not the unknown-model NULL path.
  'scripted/scripted': { promptMicroUsdPerMillion: 0n, completionMicroUsdPerMillion: 0n },
};

const logger = new Logger('LlmPricing');
// Warn once per unknown key, not per call — a hot path with a missing price
// would otherwise log-spam on every request for the whole deploy.
const warned = new Set<string>();

/**
 * Cost of one call in micro-USD, or NULL when the (provider, model) pair has
 * no declared price. NULL is deliberate: it is loudly countable
 * (`count(*) filter (where cost_micro_usd is null)`), where a silent 0 is
 * how a cost dashboard shows $0 for a month for a model nobody added.
 *
 * Unknown token counts (failed/aborted calls) read differently depending on
 * the price: a DECLARED-ZERO price computes 0n regardless of consumption —
 * Ollama really is free even when the usage event never arrives. A METERED
 * price with unknown tokens computes NULL, not 0n: "unknown consumption on a
 * billable model" is exactly the row a cost dashboard must not sum as a
 * confident $0. The token columns already carry the NULL; this keeps
 * cost_micro_usd honest with them.
 */
export function computeCostMicroUsd(
  provider: string | null,
  model: string | null,
  promptTokens: number | null,
  completionTokens: number | null,
): bigint | null {
  if (!provider || !model) return null;
  const key = `${provider}/${model}`;
  const price = PRICES[key];
  if (!price) {
    if (!warned.has(key)) {
      warned.add(key);
      logger.warn(`No price declared for ${key} — ledger rows will carry NULL cost until pricing.ts is updated`);
    }
    return null;
  }
  // A metered price cannot honestly cost an unknown call at 0; a declared
  // zero can (and must — see pricing.spec.ts:33). The token columns are the
  // source of truth for "how much", cost_micro_usd for "how much money", and
  // both must agree that the call's consumption is unknown.
  //
  // BOTH null, not EITHER, is deliberate — and currently unreachable either
  // way: every call site passes both counts off the same `usage` object
  // (chat.service.ts:347, query-rewriter.service.ts:92) or neither
  // (embedding.service.ts, and the failure paths), so one-known-one-null
  // cannot occur today. REVISIT THIS IF PARTIAL USAGE IS EVER PLUMBED — the
  // work deferred in item [6] — because billing only the known side of a
  // metered call would understate it, which is the same dishonesty this
  // guard exists to prevent. Meet the decision; do not inherit it.
  const metered = price.promptMicroUsdPerMillion > 0n || price.completionMicroUsdPerMillion > 0n;
  if (metered && promptTokens === null && completionTokens === null) return null;
  const prompt = BigInt(promptTokens ?? 0) * price.promptMicroUsdPerMillion;
  const completion = BigInt(completionTokens ?? 0) * price.completionMicroUsdPerMillion;
  return (prompt + completion) / MILLION;
}

/**
 * Whether a (provider, model) pair has a DECLARED price. Phase 7 quota
 * enforcement fails CLOSED on unpriced models: a model whose spend cannot
 * be computed cannot be bounded, and "unpriced therefore unlimited" is the
 * exact silent-$0 trap this file exists to prevent — the Phase 6 lesson,
 * applied to enforcement instead of measurement. The quota guard denies
 * requests when the active chain would run an unpriced model; the fix is
 * always "declare the price", never "broaden the quota".
 */
export function isPriced(provider: string | null, model: string | null): boolean {
  if (!provider || !model) return false;
  return PRICES[`${provider}/${model}`] !== undefined;
}
