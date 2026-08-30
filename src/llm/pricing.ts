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
  // gemini-2.0-flash: $0.10 / $0.40 per 1M input/output tokens.
  'gemini/gemini-2.0-flash': { promptMicroUsdPerMillion: 100_000n, completionMicroUsdPerMillion: 400_000n },
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
 * Unknown token counts (failed/aborted calls) count as zero tokens: a
 * flat-price provider still computes to its declared 0, and a metered call
 * whose usage never arrived costs "unknown", which NULL tokens already say.
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
  const prompt = BigInt(promptTokens ?? 0) * price.promptMicroUsdPerMillion;
  const completion = BigInt(completionTokens ?? 0) * price.completionMicroUsdPerMillion;
  return (prompt + completion) / MILLION;
}
