import { describe, expect, it } from 'vitest';
import { validateEnv } from '../src/config/env.schema';
import { harnessConfig } from './support/harness-config';

/**
 * The measurement harnesses must read config the way production does.
 *
 * Twice now a hardcoded fallback in a harness stub has drifted from the real
 * default and silently measured the wrong thing: `measure:p95` seeded
 * 'nomic-embed-text' while retrieval filtered the configured model (so the
 * vector leg returned [] on every iteration), and both harnesses kept
 * `RRF_FTS_WEIGHT ?? 0.05` after the schema default moved to 0.07 — so
 * `pnpm eval` scored the OLD weight while the app shipped the new one.
 *
 * Both bugs are the same shape: a literal in a test that duplicates a value
 * the schema already owns. The fix is to stop duplicating it, and these tests
 * are what stop it coming back a third time.
 */
describe('harnessConfig', () => {
  it('reads every retrieval knob from the validated env, never a literal', () => {
    const env = validateEnv(process.env as Record<string, unknown>);
    const config = harnessConfig();
    for (const key of ['RRF_FTS_WEIGHT', 'RRF_VECTOR_WEIGHT', 'HNSW_EF_SEARCH', 'EMBEDDING_MODEL', 'EMBEDDING_DIMENSIONS'] as const) {
      expect(config.get(key), `${key} must track the schema, not a duplicated literal`).toBe(env[key]);
    }
  });

  it('lets a spec override a knob without reintroducing a stale default', () => {
    const config = harnessConfig({ EMBEDDING_TIMEOUT_MS: 60_000 });
    expect(config.get('EMBEDDING_TIMEOUT_MS')).toBe(60_000);
    // The un-overridden keys still come from the schema.
    expect(config.get('RRF_FTS_WEIGHT')).toBe(validateEnv(process.env as Record<string, unknown>).RRF_FTS_WEIGHT);
  });

  it('throws on an unexpected key rather than returning undefined', () => {
    expect(() => harnessConfig().get('NOT_A_REAL_KEY')).toThrow(/NOT_A_REAL_KEY/);
  });
});
