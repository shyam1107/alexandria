import { validateEnv } from '../../src/config/env.schema';

/**
 * A ConfigService double for the measurement harnesses, sourced from the real
 * validated environment rather than from literals copied into each spec.
 *
 * WHY THIS EXISTS. Both harnesses previously built their own stub with
 * hardcoded fallbacks, and both drifted from the schema:
 *
 *   - `measure:p95` seeded `embedding_model = 'nomic-embed-text'` while
 *     RetrievalService filtered on the configured model. The predicate never
 *     matched, the vector leg returned [] on all 60 iterations, and the only
 *     assertion (p95 < deadline) passed trivially on the empty path.
 *   - Both harnesses kept `RRF_FTS_WEIGHT ?? 0.05` after the schema default
 *     moved to 0.07, so `pnpm eval` scored the OLD weight while the API
 *     shipped the new one — and the doc table could not be reproduced by the
 *     documented command.
 *
 * Neither was catchable by build, lint or typecheck: a stale literal is
 * type-correct. Reading through `validateEnv` makes the drift impossible
 * instead of merely fixed, which is the difference between closing an
 * instance and closing a class.
 *
 * Env vars still work exactly as they do in production (`RRF_FTS_WEIGHT=0.2
 * pnpm eval` sweeps), because validateEnv reads process.env. `overrides` is
 * for values a harness legitimately needs to differ on — a longer embedding
 * timeout while measuring, say — and is explicit at the call site.
 */
export function harnessConfig(overrides: Record<string, unknown> = {}) {
  const env = validateEnv(process.env as Record<string, unknown>);
  const values: Record<string, unknown> = {
    EMBEDDING_BASE_URL: env.EMBEDDING_BASE_URL,
    EMBEDDING_MODEL: env.EMBEDDING_MODEL,
    EMBEDDING_DIMENSIONS: env.EMBEDDING_DIMENSIONS,
    EMBEDDING_TIMEOUT_MS: env.EMBEDDING_TIMEOUT_MS,
    EMBEDDING_MAX_RETRIES: env.EMBEDDING_MAX_RETRIES,
    EMBEDDING_CACHE_TTL_SECONDS: env.EMBEDDING_CACHE_TTL_SECONDS,
    HNSW_EF_SEARCH: env.HNSW_EF_SEARCH,
    RRF_VECTOR_WEIGHT: env.RRF_VECTOR_WEIGHT,
    RRF_FTS_WEIGHT: env.RRF_FTS_WEIGHT,
    ...overrides,
  };
  return {
    get: (key: string) => {
      if (!(key in values)) throw new Error(`harness config: unexpected key ${key}`);
      return values[key];
    },
  };
}
