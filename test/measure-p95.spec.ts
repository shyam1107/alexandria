import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import * as schema from '../src/database/schema';
import { RetrievalService } from '../src/retrieval/retrieval.service';
import { EmbeddingService } from '../src/ingestion/embedding.service';
import { EmbeddingCache } from '../src/ingestion/embedding-cache.service';
import type { UsageLedger } from '../src/llm/usage-ledger';
import type { Db } from '../src/database/database.module';

/**
 * The latency instrument behind doc 12's numbers.
 *
 * Doc 12's rule is that a number without a method is a guess, so this file IS
 * the method: it seeds a corpus of a stated size, drives the real
 * RetrievalService against the real database as the runtime role (RLS
 * active), calls the real embedding provider over HTTP, and prints
 * percentiles over a stated sample.
 *
 *   pnpm measure:p95
 *
 * SKIPPED unless MEASURE=1, because it seeds 5,000 chunks and calls a model
 * ~180 times — minutes, not milliseconds. It lives under test/ rather than
 * scripts/ for one practical reason: it constructs Nest providers, and Node's
 * type stripping cannot load decorator metadata, so a plain .mts script
 * cannot import these classes at all.
 *
 * It is a local instrument, not a benchmark rig: one process, one machine, no
 * isolation from whatever else is running. Re-run it and the numbers move.
 * That is the honest shape of a p95 claim in a repository.
 */

const RUN = process.env.MEASURE === '1';
const CHUNKS_PER_DOC = 40;
const DOCS_TENANT_A = 100; // 4,000 chunks — the tenant under test
const DOCS_TENANT_B = 25; //  1,000 chunks — a neighbour, so the tenant filter is selective
const ITERATIONS = Number(process.env.MEASURE_ITERATIONS ?? 60);
const DIMENSIONS = 768;

const QUERIES = [
  'what is the refund window for annual plans',
  'how do I rotate an API key',
  'which regions support data residency',
  'what happens when a payment fails',
  'how is uptime measured in the SLA',
];

/** Random unit vectors — a realistic HNSW workload, unlike one-hot fixtures. */
function randomVector(): string {
  const v = new Array<number>(DIMENSIONS);
  let norm = 0;
  for (let i = 0; i < DIMENSIONS; i++) {
    const x = Math.random() * 2 - 1;
    v[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIMENSIONS; i++) v[i] /= norm;
  return `[${v.join(',')}]`;
}

const WORDS =
  'refund policy annual plan api key rotation region data residency payment failure sla uptime credit invoice retention export encryption audit log webhook retry latency quota seat licence renewal proration'.split(
    ' ',
  );
const randomText = (seed: number) => Array.from({ length: 60 }, (_, i) => WORDS[(seed * 7 + i * 13) % WORDS.length]).join(' ');

function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

/** Vitest intercepts stdout, so the report is accumulated and written to a
 *  file as well — which also makes the numbers doc 12 quotes reproducible
 *  rather than something scraped out of a terminal. */
const lines: string[] = [];
const emit = (line: string) => {
  lines.push(line);
  console.log(line);
};

function report(label: string, samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((s, n) => s + n, 0) / sorted.length;
  const fmt = (n: number) => `${n.toFixed(1).padStart(8)}ms`;
  const p95 = percentile(sorted, 95);
  emit(
    `${label.padEnd(36)} n=${String(sorted.length).padStart(3)}  p50${fmt(percentile(sorted, 50))}  p95${fmt(p95)}  p99${fmt(percentile(sorted, 99))}  mean${fmt(mean)}`,
  );
  return p95;
}

describe.runIf(RUN)('latency measurement (MEASURE=1)', () => {
  let owner: Client;
  let pool: Pool;
  let redis: Redis | undefined;
  let retrieval: RetrievalService;
  let uncached: EmbeddingService;
  let cached: EmbeddingService;
  let wsA: string;
  let wsB: string;

  const config = {
    get: (key: string) => {
      const values: Record<string, unknown> = {
        EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL ?? 'http://localhost:11434',
        EMBEDDING_MODEL: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
        EMBEDDING_DIMENSIONS: DIMENSIONS,
        EMBEDDING_TIMEOUT_MS: 30_000,
        EMBEDDING_MAX_RETRIES: 1,
        EMBEDDING_CACHE_TTL_SECONDS: 3_600,
        HNSW_EF_SEARCH: Number(process.env.HNSW_EF_SEARCH ?? 80),
      };
      if (!(key in values)) throw new Error(`measure: unexpected config key ${key}`);
      return values[key];
    },
  } as never;

  // Measuring retrieval, not metering: a real ledger would add its own INSERT
  // to every sample and the number would stop being about retrieval.
  const ledger = { record: async () => undefined } as unknown as UsageLedger;

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    const db = drizzle(pool, { schema }) as unknown as Db;

    uncached = new EmbeddingService(config, ledger);
    retrieval = new RetrievalService(db, uncached, config);
    if (process.env.REDIS_URL) {
      redis = new Redis(process.env.REDIS_URL);
      cached = new EmbeddingService(config, ledger, new EmbeddingCache(redis, config));
    }

    const tag = `p95-${Date.now()}`;
    const started = performance.now();
    [{ id: wsA }] = (await owner.query(`insert into workspaces (name) values ($1) returning id`, [`${tag}-a`])).rows;
    [{ id: wsB }] = (await owner.query(`insert into workspaces (name) values ($1) returning id`, [`${tag}-b`])).rows;

    for (const [ws, docCount] of [
      [wsA, DOCS_TENANT_A],
      [wsB, DOCS_TENANT_B],
    ] as const) {
      for (let d = 0; d < docCount; d++) {
        const [{ id: docId }] = (
          await owner.query(`insert into documents (workspace_id, title, status) values ($1, $2, 'indexed') returning id`, [ws, `doc-${d}`])
        ).rows;
        const [{ id: versionId }] = (
          await owner.query(
            `insert into document_versions (document_id, workspace_id, object_key, original_filename, content_type, byte_size, content_hash, status, embedding_model)
             values ($1, $2, $3, $4, 'text/plain', 1024, $5, 'indexed', 'nomic-embed-text') returning id`,
            [docId, ws, `k/${randomUUID()}`, `doc-${d}.txt`, randomUUID().replace(/-/g, '')],
          )
        ).rows;
        const values: string[] = [];
        const params: unknown[] = [];
        for (let c = 0; c < CHUNKS_PER_DOC; c++) {
          const i = params.length;
          values.push(`($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}::vector, 'nomic-embed-text')`);
          params.push(versionId, ws, c, randomText(d * CHUNKS_PER_DOC + c), randomVector());
        }
        await owner.query(
          `insert into document_chunks (document_version_id, workspace_id, chunk_index, content, embedding, embedding_model) values ${values.join(',')}`,
          params,
        );
      }
    }
    await owner.query('analyze document_chunks');
    lines.push(`seeded ${(DOCS_TENANT_A + DOCS_TENANT_B) * CHUNKS_PER_DOC} chunks in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }, 900_000);

  afterAll(async () => {
    if (owner) {
      await owner.query(`delete from workspaces where id = any($1::uuid[])`, [[wsA, wsB].filter(Boolean)]);
      await owner.end();
    }
    if (pool) await pool.end();
    if (redis) await redis.quit();
  });

  it('reports p50/p95/p99 for every stage of the read path', async () => {
    // The first call pays model load and first-touch page cache — a real cost,
    // but not a steady-state one, so it is reported separately rather than
    // silently inflating p99.
    const coldStart = performance.now();
    await uncached.embed(QUERIES[0], { workspaceId: wsA, operation: 'embedding_query' });
    const coldMs = performance.now() - coldStart;
    await retrieval.search(wsA, { query: QUERIES[0], topK: 8 });

    const embedSamples: number[] = [];
    const retrievalSamples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const query = `${QUERIES[i % QUERIES.length]} ${i}`; // unique: never a cache hit

      const e0 = performance.now();
      await uncached.embed(query, { workspaceId: wsA, operation: 'embedding_query' });
      embedSamples.push(performance.now() - e0);

      const r0 = performance.now();
      await retrieval.search(wsA, { query, topK: 8 });
      retrievalSamples.push(performance.now() - r0);
    }

    const cachedSamples: number[] = [];
    if (cached) {
      for (let i = 0; i < ITERATIONS; i++) {
        const text = `cache probe ${Date.now()} ${i}`;
        await cached.embed(text, { workspaceId: wsA, operation: 'embedding_query' }); // miss, primes
        const c0 = performance.now();
        await cached.embed(text, { workspaceId: wsA, operation: 'embedding_query' }); // hit
        cachedSamples.push(performance.now() - c0);
      }
    }

    const sqlOnly = retrievalSamples.map((total, i) => total - embedSamples[i]);

    emit(
      `corpus ${(DOCS_TENANT_A + DOCS_TENANT_B) * CHUNKS_PER_DOC} chunks (${DOCS_TENANT_A * CHUNKS_PER_DOC} in the tenant under test), ` +
        `HNSW_EF_SEARCH=${process.env.HNSW_EF_SEARCH ?? 80}, topK=8`,
    );
    emit(`embedding cold start (first call, excluded below): ${coldMs.toFixed(0)}ms`);
    emit('');
    report('embedding call (uncached, HTTP)', embedSamples);
    if (cachedSamples.length) report('embedding call (cache HIT, Redis)', cachedSamples);
    const retrievalP95 = report('retrieval total (embed + both legs)', retrievalSamples);
    report('  └ SQL only (total − embed)', sqlOnly);
    emit('');
    emit('SQL-only is derived per iteration, not timed independently: both legs run');
    emit('inside one transaction and separating them would require instrumenting');
    emit('private methods, which changes what is being measured.');
    const out = process.env.MEASURE_OUT ?? 'measure-p95.txt';
    writeFileSync(out, `${lines.join('\n')}\n`);

    // The one assertion. Retrieval is the dominant term in the pre-frame
    // window that CHAT_PRE_FRAME_DEADLINE_MS bounds, so if p95 retrieval ever
    // approaches the deadline, the deadline is no longer headroom — it is a
    // coin flip, and the outcome is a 503 for a healthy request.
    const deadlineMs = Number(process.env.CHAT_PRE_FRAME_DEADLINE_MS ?? 20_000);
    expect(retrievalP95, 'retrieval p95 must stay well inside the pre-frame deadline').toBeLessThan(deadlineMs / 2);
  }, 900_000);
});
