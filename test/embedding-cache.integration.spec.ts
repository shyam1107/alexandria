import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { vi } from 'vitest';
import { EmbeddingCache } from '../src/ingestion/embedding-cache.service';
import { EmbeddingService } from '../src/ingestion/embedding.service';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../src/config/env.schema';
import type { UsageEntry, UsageLedger } from '../src/llm/usage-ledger';

/**
 * The Phase 7 embedding cache. THE test this file exists for is the tenant
 * one — the same property from two directions:
 *
 * 1. A workspace CANNOT read another workspace's cached entry as anything
 *    other than the model's own pure-function output. There is no
 *    per-workspace entry to leak: the key is (model, text) and the VALUE is
 *    numbers, so the test asserts the stored value contains nothing but
 *    the vector — no content, no metadata, no tenant association.
 *
 * 2. The converse, which is the actual hit-rate justification: workspace B
 *    embedding IDENTICAL text to workspace A gets a cache HIT — because
 *    the model itself would return the same vector to both. Not sharing
 *    would forfeit the hit rate without buying any isolation.
 *
 * Plus the two correctness invariants: the model is IN the key (a model
 * change never serves old-space vectors — the cross-provider fallback
 * catastrophe, applied to caching), and a cache hit records NO ledger row
 * (no provider call happened, so no spend happened).
 *
 * All against real Redis — a cache suite against a Map double would test
 * the double, not the expiry, the serialization, or the atomicity of set-EX.
 */

const VECTOR = Array.from({ length: 768 }, (_, i) => i / 768);
const WORKSPACE_A = '11111111-1111-1111-1111-111111111111';
const WORKSPACE_B = '22222222-2222-2222-2222-222222222222';

function makeConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    EMBEDDING_BASE_URL: 'http://embeddings.test',
    EMBEDDING_MODEL: 'nomic-embed-text',
    EMBEDDING_DIMENSIONS: 768,
    EMBEDDING_TIMEOUT_MS: 5_000,
    EMBEDDING_MAX_RETRIES: 1,
    EMBEDDING_CACHE_TTL_SECONDS: 3_600,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
}

function recordingLedger() {
  const rows: Array<{ workspaceId: string; entry: UsageEntry }> = [];
  return {
    ledger: { record: async (workspaceId: string, entry: UsageEntry) => rows.push({ workspaceId, entry }) } as unknown as UsageLedger,
    rows,
  };
}

const okResponse = () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ embedding: VECTOR }) } as Response);

describe('embedding cache (integration, real Redis)', () => {
  let redis: Redis;
  let cache: EmbeddingCache;

  beforeAll(async () => {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL must be set.');
    redis = new Redis(url);
    cache = new EmbeddingCache(redis, makeConfig());
  });

  afterAll(async () => {
    if (redis) await redis.quit();
  });

  it('returns the same vector for identical text regardless of workspace — the pure-function property', async () => {
    const text = 'refund policy for the standard plan';
    await cache.set('nomic-embed-text', text, VECTOR);

    // Workspace B reads the same text: HIT. Not a leak — the model would
    // have returned this vector to B anyway.
    const hitForB = await cache.get('nomic-embed-text', text);
    expect(hitForB).toEqual(VECTOR);
  });

  it('THE ISOLATION TEST: the cached VALUE is the vector and nothing else', async () => {
    const text = `tenant secret document ${Date.now()}`;
    await cache.set('nomic-embed-text', text, VECTOR);

    const raw = await redis.get(EmbeddingCache.key('nomic-embed-text', text));
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!) as unknown[];
    // The value must be a bare array of numbers: no content, no workspace
    // id, no metadata. Anything else would be tenant data in a shared key.
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.every((n: unknown) => typeof n === 'number')).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain(WORKSPACE_A);
    expect(JSON.stringify(parsed)).not.toContain('workspace');
  });

  it('normalizes whitespace: the model does not see the difference, so neither does the key', async () => {
    await cache.set('nomic-embed-text', 'line one\n\n   line two', VECTOR);
    const hit = await cache.get('nomic-embed-text', '  line one line two  ');
    expect(hit).toEqual(VECTOR);
  });

  it('puts the model IN the key: a model change never serves old-space vectors', async () => {
    await cache.set('nomic-embed-text', 'same text, new model era', VECTOR);
    // A different model must MISS, even for identical text.
    const miss = await cache.get('some-other-model', 'same text, new model era');
    expect(miss).toBeNull();
    // And the keys differ as strings, so no collision is possible.
    expect(EmbeddingCache.key('a', 'x')).not.toBe(EmbeddingCache.key('b', 'x'));
  });

  it('serves the second call from cache: no provider call, no ledger row', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
    try {
      const { ledger, rows } = recordingLedger();
      const service = new EmbeddingService(makeConfig(), ledger, cache);
      const contextA = { workspaceId: WORKSPACE_A, operation: 'embedding_query' as const };
      const contextB = { workspaceId: WORKSPACE_B, operation: 'embedding_query' as const };

      // Unique per run: the cache TTL is an hour and this is the one test
      // in the file that depends on the FIRST call missing, so a fixed
      // string would be served from the previous run's entry and record no
      // ledger row at all. The two calls must share text, not the suite.
      const text = `the quick brown fox ${Date.now()}`;

      const first = await service.embed(text, contextA);
      expect(first).toEqual(VECTOR);
      const providerCallsAfterFirst = rows.length;

      // Same text, different workspace: cache hit — no fetch, no ledger row.
      const second = await service.embed(text, contextB);
      expect(second).toEqual(VECTOR);
      expect(rows.length).toBe(providerCallsAfterFirst);
      // Exactly ONE provider call total (the first embed), one ledger row.
      expect(rows).toHaveLength(1);
      expect(rows[0].workspaceId).toBe(WORKSPACE_A);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('exercises the re-ingest path: the same chunk content is free the second time', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
    try {
      const { ledger, rows } = recordingLedger();
      const service = new EmbeddingService(makeConfig(), ledger, cache);
      const chunk = `chunk content for re-ingest ${Date.now()}`;

      await service.embed(chunk, { workspaceId: WORKSPACE_A, operation: 'embedding_index' });
      await service.embed(chunk, { workspaceId: WORKSPACE_A, operation: 'embedding_index' });

      // One provider call for two ingestions of the same content.
      expect(rows).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a cache outage degrades to the provider path, never fails the embed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
    try {
      const { ledger } = recordingLedger();
      const brokenRedis = new Redis(process.env.REDIS_URL!);
      await brokenRedis.quit(); // a closed client rejects every command
      const brokenCache = new EmbeddingCache(brokenRedis, makeConfig());
      const service = new EmbeddingService(makeConfig(), ledger, brokenCache);

      const embedding = await service.embed(`degraded path ${Date.now()}`, { workspaceId: WORKSPACE_A, operation: 'embedding_query' });
      expect(embedding).toEqual(VECTOR);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});