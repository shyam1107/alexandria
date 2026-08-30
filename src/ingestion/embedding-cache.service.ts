import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';

/**
 * The Phase 7 embedding cache. What it is NOT matters more than what it is:
 *
 * NOT the semantic cache. This stores EXACT (model, text) → vector pairs —
 * a pure function memoized, not a similarity search. The semantic cache
 * (stored answer for a SIMILAR question) is deferred to Phase 8 with the
 * eval harness, per the Phase 7 design decision: its similarity threshold
 * is a quality trade-off with no defensible default until the harness can
 * tune it, its entries risk stale citations, and a cache key that is not
 * workspace-scoped is the single worst bug this project could ship.
 * Exact-match caching has none of those traps.
 *
 * WHY THE MODEL IS IN THE KEY: changing EMBEDDING_MODEL with a cache keyed
 * on text alone would silently serve vectors from the OLD model's space —
 * the exact catastrophe class the cross-provider embedding fallback refuses
 * (see EmbeddingService). The key is sha256(model \0 normalized-text); a
 * model change misses every entry, which is the only correct behaviour.
 *
 * WHY NO WORKSPACE SCOPING: an embedding is a pure function of (model,
 * text). Two workspaces embedding the same text receive the same vector
 * from the model itself — sharing the memoized copy leaks nothing, and
 * NOT sharing it would forfeit the hit rate on common text (headers,
 * boilerplate). The cached VALUE is the vector, nothing else — no content,
 * no metadata, no tenant association. The test asserts both directions:
 * another workspace's identical text hits, and the stored value contains
 * nothing but numbers.
 *
 * HIT RATE REALITY: query embeddings repeat (users ask similar things);
 * ingestion chunks mostly don't, except on re-ingest of an unchanged
 * document — where the cache turns a 500-chunk re-embedding bill into
 * zero. That alone justifies the cache; query hits are the bonus.
 *
 * Failure semantics: cache errors never fail the embed call — a cache
 * outage degrades to the uncached path (the ledger still records the
 * provider call). Availability over optimization, same call as every
 * other Phase 7 layer.
 */
@Injectable()
export class EmbeddingCache {
  private readonly ttlSeconds: number;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.ttlSeconds = config.get('EMBEDDING_CACHE_TTL_SECONDS', { infer: true });
  }

  /** Cache key: model in the key, normalized text, hashed. */
  static key(model: string, text: string): string {
    const normalized = text.trim().replace(/\s+/g, ' ');
    return `emb:${createHash('sha256').update(`${model}\0${normalized}`).digest('hex')}`;
  }

  async get(model: string, text: string): Promise<number[] | null> {
    try {
      const raw = await this.redis.get(EmbeddingCache.key(model, text));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as number[];
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null; // cache read failure = miss, never an error to the caller
    }
  }

  async set(model: string, text: string, embedding: number[]): Promise<void> {
    try {
      await this.redis.set(EmbeddingCache.key(model, text), JSON.stringify(embedding), 'EX', this.ttlSeconds);
    } catch {
      // Cache write failure degrades to uncached; the ledger still sees the
      // provider call on the next miss. Never propagate.
    }
  }
}