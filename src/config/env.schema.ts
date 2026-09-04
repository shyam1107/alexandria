import { z } from 'zod';

/**
 * Single source of truth for every environment variable the app reads.
 *
 * Fail-fast principle: if configuration is invalid, the process must refuse
 * to boot with a precise error — not limp along and fail at 3am when the
 * first request touches the misconfigured dependency.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().startsWith('postgres', 'must be a postgres:// connection string'),
  REDIS_URL: z.string().startsWith('redis', 'must be a redis:// connection string'),

  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // Abandoned-upload sweeper (Phase 7b). A presigned URL is handed out and
  // the client may simply never PUT: the row stays `pending` and, if the PUT
  // half-succeeded, the object sits in the bucket forever.
  //
  // Why a sweeper and not an S3 lifecycle rule: object keys are
  // `workspace/document/version/filename` with NO prefix separating pending
  // from completed uploads, so a blind age-based expiry would delete live
  // documents. Only the database knows which uploads were abandoned. If the
  // key layout ever grows a `pending/` prefix, a bucket rule becomes the
  // cheaper answer and this can go.
  //
  // 24h, not 15 minutes: the presign TTL bounds when an upload can still
  // succeed, but a generous margin keeps the sweeper away from anything a
  // slow client or a retried upload might still be using.
  ABANDONED_UPLOAD_TTL_HOURS: z.coerce.number().int().positive().default(24),
  UPLOAD_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  MAX_DOCUMENT_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  // INGESTION_QUEUE is deliberately NOT configurable and must not be
  // re-added. Renaming a queue at runtime does not migrate anything: every
  // job already enqueued under the old name is orphaned, invisible to the
  // worker, and never processed. The name is a constant in
  // ingestion.constants.ts. Worker CONCURRENCY, below, is a genuine tuning
  // knob and is wired.
  //
  // Read by the @Processor decorator via process.env, because decorator
  // options are evaluated at class-definition time and cannot reach
  // ConfigService. This schema still owns validation: an invalid value
  // fails the boot regardless of what the decorator saw.
  INGESTION_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  EMBEDDING_BASE_URL: z.string().default('http://localhost:11434'),
  // snowflake-arctic-embed:110m, chosen on measured grounds (2026-08-30).
  // Benchmarked the whole Ollama embedding catalogue on this hardware, each
  // model isolated and pre-warmed: every usable 768-dim model lands at
  // 270-307ms/chunk, so speed was never the differentiator it looked like.
  // Arctic wins on the axis that IS different: MTEB retrieval NDCG@10 of
  // 54.90 vs nomic's 53.25, at 110M params vs 137M, with identical 768
  // dimensions so no migration is needed. The faster options (all-minilm,
  // granite:30m at ~75ms) are 384-dim and score ~42 on retrieval — four
  // times the speed for the one quality that this product sells.
  // qwen3-embedding:0.6b is 2260ms/chunk here and 1024-dim: unusable.
  // CHANGING THIS REQUIRES A RE-INDEX. Vectors from two models are not
  // comparable, and the vector leg now filters on embedding_model to
  // enforce that.
  EMBEDDING_MODEL: z.string().default('snowflake-arctic-embed:110m'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(768).refine((value) => value === 768, 'Phase 3 schema requires 768-dimensional embeddings'),
  // HNSW visit budget per query. pgvector's default (40) is tuned for global
  // search; per-tenant filtered search needs headroom for the iterative scan
  // to reach past the global top-k cut. 80 doubles the default — measured
  // latency cost is small (graph traversal, not heap sort), and doc 12 charts
  // recall vs ef_search so this number stays a measurement, not folklore.
  // Hard cap is 1000 (pgvector enforces 1..1000).
  // Per-signal fusion weights (Phase 8, measured on the golden set). The
  // keyword leg answers every natural-language question once it uses OR
  // semantics, including ones it should stay quiet about; unweighted fusion
  // gives that noise a vote equal to a confident vector match. Tuned with
  // `pnpm eval`, not guessed — see doc 14 for the sweep.
  RRF_VECTOR_WEIGHT: z.coerce.number().positive().default(1),
  // 0.05 is measured, not guessed. Swept on the golden set (`pnpm eval`):
  //
  //   ftsW   recall@5   MRR    nDCG@5
  //   1.00     1.000    0.856   0.893
  //   0.15     1.000    0.889   0.917
  //   0.10     1.000    0.900   0.926
  //   0.05     1.000    0.933   0.943   <- chosen
  //   0.02     0.967    0.933   0.925
  //   (vector only: 0.967 / 0.933 / 0.935)
  //
  // At 0.05 hybrid strictly beats vector-only on every metric; at 0.02 the
  // keyword leg stops contributing the chunks the vector leg misses and
  // recall falls back to vector-only's. The value looks tiny because RRF's
  // 1/(k+rank) with k=60 compresses every contribution into a narrow band —
  // and because the right ROLE for this leg is tie-breaker that surfaces
  // what the vector leg missed, not co-equal ranker. Re-run the sweep if the
  // embedding model, k, or the corpus mix changes.
  RRF_FTS_WEIGHT: z.coerce.number().positive().default(0.05),
  HNSW_EF_SEARCH: z.coerce.number().int().min(1).max(1000).default(80),
  CHUNK_SIZE: z.coerce.number().int().positive().default(1200),
  CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(200),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),

  OLLAMA_BASE_URL: z.string().default('http://localhost:11434'),
  GEMINI_API_KEY: z.string().optional(),

  // Generation (Phase 5). OLLAMA_API_KEY stays optional: local Ollama has no
  // auth, and the provider sends the Bearer header only when this is set —
  // same code path for localhost and ollama.com.
  OLLAMA_API_KEY: z.string().optional(),
  // Phase 6: the fallback chain, comma-separated, in order. 'scripted'
  // short-circuits to a deterministic provider for CI and smoke runs. Every
  // chain — even one provider — gets retries and stream deadlines from the
  // resilient wrapper.
  LLM_CHAIN: z.string().default('ollama'),
  GENERATION_MODEL: z.string().default('gpt-oss:120b'),
  GEMINI_BASE_URL: z.string().default('https://generativelanguage.googleapis.com'),
  // Free-tier friendly, non-reasoning — the same token-frugality call that
  // picked gpt-oss:120b over the reasoning models.
  // gemini-3.1-flash-lite, chosen on MEASURED grounds (2026-08-30), not vibes:
  // cheapest listed flash tier ($0.25/$1.50 per 1M) AND the only one of the
  // three probed that spends ZERO thinking tokens, while returning the same
  // correct, correctly-cited answer as gemini-2.5-flash on a grounded RAG
  // question. Thinking tokens bill at OUTPUT rates, so on this workload the
  // reasoning models cost ~13x more for no better answer — which is Phase 5's
  // "reasoning models are token-hungry for synthesis" finding, now with
  // numbers. Grounded extractive answering is not a reasoning task.
  GEMINI_MODEL: z.string().default('gemini-3.1-flash-lite'),
  // The flash tier's real input limit. Rarely binds: the composite chain
  // reports the MINIMUM window across providers, and chat budgeting is
  // capped by CHAT_CONTEXT_TOKEN_BUDGET anyway.
  GEMINI_NUM_CTX: z.coerce.number().int().positive().default(1_048_576),
  // Ollama defaults num_ctx to 2048 regardless of the model's advertised
  // window and then silently truncates the FRONT of the prompt — where the
  // system prompt lives. Always send it explicitly.
  GENERATION_NUM_CTX: z.coerce.number().int().positive().default(8192),
  GENERATION_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  // Grounded, cite-your-sources answering is not a creative task. Ollama's
  // default is 0.8, which measurably increases both invention and citation
  // drift — the behaviour Phase 8 exists to measure, so it must be pinned and
  // configurable rather than inherited.
  GENERATION_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  // Phase 6 resilience knobs. Two retries per chain step: enough for a
  // transient blip, not enough to turn a dead provider into a 30s stall
  // before fallback.
  LLM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
  LLM_RETRY_BASE_MS: z.coerce.number().int().positive().default(500),
  // A provider saying "wait 60s" via Retry-After is a fallback signal, not a
  // retry invitation — clamp it.
  LLM_RETRY_AFTER_CAP_MS: z.coerce.number().int().positive().default(10_000),
  // Two deadlines, not one total timeout: a cold local model load is
  // legitimately 10–20s to FIRST token, and a long answer is legitimately
  // slow — but 30s of silence mid-stream is a stall, not thinking.
  LLM_FIRST_TOKEN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  LLM_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // Circuit breaker (Phase 7b), the seam Phase 6 designed and deferred.
  // Three consecutive PRE-FIRST-TOKEN failures trip a provider: enough that a
  // single blip plus its retries does not open the breaker, few enough that a
  // genuinely dead provider stops costing every request its full retry
  // budget before the chain falls through.
  LLM_BREAKER_THRESHOLD: z.coerce.number().int().positive().default(3),
  // Cooldown before ONE half-open probe is allowed. 30s: long enough that a
  // dead provider is not probed on every request, short enough that recovery
  // is noticed within a user's patience. State is per process on purpose —
  // see the comment on ResilientProvider.
  LLM_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(30_000),
  // Embeddings are single request/response, so one plain timeout suffices.
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  EMBEDDING_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
  // Exact-match embedding cache (model + normalized text → vector), Phase 7.
  // 24h: long enough to make re-ingest of unchanged documents free, short
  // enough that a model change (which misses the cache anyway by key) or
  // provider-side drift ages out naturally. Cache failures never fail the
  // embed call — this knob only shapes the hit rate.
  EMBEDDING_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  CHAT_HISTORY_MESSAGES: z.coerce.number().int().positive().default(10),
  // A message COUNT is not a size bound: ten turns of 4000-char questions and
  // 1024-token answers is ~10k tokens on its own. History is capped by tokens
  // too, and the oldest turns are dropped first.
  CHAT_HISTORY_TOKEN_BUDGET: z.coerce.number().int().positive().default(1500),
  // A ceiling, not an allocation: the effective context budget is the smaller
  // of this and whatever the model's window has left after the system prompt,
  // history, the question, and the reserved output.
  CHAT_CONTEXT_TOKEN_BUDGET: z.coerce.number().int().positive().default(3000),
  // Phase 7: the pre-frame window and its sub-budget. Before the first SSE
  // frame, a chat request resolves the conversation, replays idempotency,
  // reads history, rewrites the query and retrieves — and the status line is
  // still ours, so failures there are real HTTP errors. That window is now
  // bounded: 20s sits comfortably below the 60s idle timeout nginx applies
  // by default, so the deadline — not the proxy — decides the error the
  // client sees. Once the first frame is out, this deadline is disarmed: a
  // long answer is legitimate, and mid-stream failures are error frames by
  // the SSE grammar.
  CHAT_PRE_FRAME_DEADLINE_MS: z.coerce.number().int().positive().default(20_000),
  // The rewrite is an optimization inside that window, not a dependency —
  // it fails open to the raw question by design. A cold model must not eat
  // the whole window the user is waiting in, so it gets its own ~25% budget;
  // on expiry the abort carries RewriteBudgetError and the ledger records a
  // 'timeout', not a 'client_disconnect'.
  CHAT_REWRITE_BUDGET_MS: z.coerce.number().int().positive().default(5_000),
  // Heartbeat comment interval, mid-stream only. Idle proxies kill
  // connections at 30–60s; a comment every 15s keeps the socket alive
  // without touching the event grammar. Armed at the FIRST FRAME, never at
  // handler entry: a ping calls the same lazy write that commits the 200,
  // so a timer armed earlier could commit the status before the handler has
  // decided what it is (Phase 7: that race made the error contract depend
  // on whether retrieval beat the first 15s tick).
  CHAT_HEARTBEAT_MS: z.coerce.number().int().positive().default(15_000),
}).superRefine((env, ctx) => {
  // Cross-field fail-fast. A chain that names gemini with no key parses
  // fine, boots fine, and looks configured — the GeminiProvider only throws
  // when it is first asked to stream. That failure lands at the worst
  // possible moment: a fallback is exercised precisely when the primary is
  // already down, so a missing key turns one outage into two and is
  // discovered mid-incident. Refuse to boot instead.
  const chain = env.LLM_CHAIN.split(',').map((name) => name.trim()).filter(Boolean);
  if (chain.includes('gemini') && !env.GEMINI_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['GEMINI_API_KEY'],
      message: 'LLM_CHAIN names gemini, so GEMINI_API_KEY must be set',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
