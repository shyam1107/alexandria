import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { writeFileSync } from 'node:fs';
import * as schema from '../src/database/schema';
import type { Db } from '../src/database/database.module';
import { RetrievalService } from '../src/retrieval/retrieval.service';
import { EmbeddingService } from '../src/ingestion/embedding.service';
import type { UsageLedger } from '../src/llm/usage-ledger';
import { EVAL_CASES, EVAL_DOCUMENTS } from '../src/eval/dataset';
import { aggregate, type AggregateScores } from '../src/eval/metrics';

/**
 * The RAG evaluation harness: retrieval quality, measured.
 *
 *   pnpm eval
 *
 * Gated behind EVAL=1 because it embeds the whole golden corpus with the REAL
 * model — minutes on a CPU — and because its output is a report, not a
 * pass/fail signal. The metric arithmetic it depends on is unit-tested
 * separately in `src/eval/metrics.spec.ts`, which DOES run in CI: the maths is
 * the part that can silently be wrong.
 *
 * What makes this more than a number generator: it scores the SAME questions
 * three ways — hybrid (RRF), vector-only, and keyword-only — so the
 * architecture decision from Phase 4 stops being an argument and becomes a
 * table. If fusion does not beat both legs, that is a finding, and it should
 * be reported rather than explained away.
 *
 * Method note: per-leg rankings are reconstructed from the debug signals of
 * one hybrid search rather than by running the legs separately. That is exact
 * only while topK is large enough to contain every candidate either leg
 * produced, which is why the corpus is ~20 chunks and topK is set above it.
 * On a large corpus this reconstruction would be lossy and the harness would
 * need the legs exposed directly.
 */

const RUN = process.env.EVAL === '1';
const TOP_K = 20; // >= corpus size, so no candidate is lost before scoring
const REPORT_AT_K = 5; // what the generator actually reads

interface Scored { hybrid: AggregateScores; vector: AggregateScores; fts: AggregateScores }

function table(title: string, rows: Array<[string, AggregateScores]>): string[] {
  const lines = [``, title, `${'strategy'.padEnd(14)}${'recall@5'.padStart(10)}${'MRR'.padStart(9)}${'nDCG@5'.padStart(9)}${'hit@5'.padStart(8)}${'cases'.padStart(7)}`];
  for (const [name, s] of rows) {
    lines.push(
      name.padEnd(14) +
        s.recallAtK.toFixed(3).padStart(10) +
        s.mrr.toFixed(3).padStart(9) +
        s.ndcgAtK.toFixed(3).padStart(9) +
        s.hitRate.toFixed(3).padStart(8) +
        String(s.cases).padStart(7),
    );
  }
  return lines;
}

describe.runIf(RUN)('RAG retrieval evaluation (EVAL=1)', () => {
  let owner: Client;
  let pool: Pool;
  let retrieval: RetrievalService;
  let workspaceId: string;
  const chunkIdByKey = new Map<string, string>();
  const report: string[] = [];

  const config = {
    get: (key: string) => {
      const values: Record<string, unknown> = {
        EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL ?? 'http://localhost:11434',
        EMBEDDING_MODEL: process.env.EMBEDDING_MODEL ?? 'snowflake-arctic-embed:110m',
        EMBEDDING_DIMENSIONS: 768,
        EMBEDDING_TIMEOUT_MS: 60_000,
        EMBEDDING_MAX_RETRIES: 1,
        HNSW_EF_SEARCH: Number(process.env.HNSW_EF_SEARCH ?? 80),
        RRF_VECTOR_WEIGHT: Number(process.env.RRF_VECTOR_WEIGHT ?? 1),
        RRF_FTS_WEIGHT: Number(process.env.RRF_FTS_WEIGHT ?? 0.05),
      };
      if (!(key in values)) throw new Error(`eval: unexpected config key ${key}`);
      return values[key];
    },
  } as never;

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    const db = drizzle(pool, { schema }) as unknown as Db;
    const ledger = { record: async () => undefined } as unknown as UsageLedger;
    const embeddings = new EmbeddingService(config, ledger);
    retrieval = new RetrievalService(db, embeddings, config);

    workspaceId = (await owner.query(`insert into workspaces (name) values ('eval-golden') returning id`)).rows[0].id;
    const model = (config as unknown as { get: (k: string) => string }).get('EMBEDDING_MODEL');

    for (const doc of EVAL_DOCUMENTS) {
      const documentId = (
        await owner.query(`insert into documents (workspace_id, title, status) values ($1, $2, 'indexed') returning id`, [workspaceId, doc.title])
      ).rows[0].id;
      const versionId = (
        await owner.query(
          `insert into document_versions (document_id, workspace_id, object_key, original_filename, content_type, byte_size, status, embedding_model)
           values ($1, $2, $3, $4, 'text/plain', 100, 'indexed', $5) returning id`,
          [documentId, workspaceId, `eval/${doc.title}`, `${doc.title}.txt`, model],
        )
      ).rows[0].id;
      for (const [index, chunk] of doc.chunks.entries()) {
        // Real embeddings: a golden set scored with stub vectors evaluates the
        // plumbing, not the retrieval.
        const vector = await embeddings.embed(chunk.content, { workspaceId, operation: 'embedding_index' });
        const id = (
          await owner.query(
            `insert into document_chunks (document_version_id, workspace_id, chunk_index, content, char_start, char_end, embedding, embedding_model)
             values ($1, $2, $3, $4, 0, $5, $6::vector, $7) returning id`,
            [versionId, workspaceId, index, chunk.content, chunk.content.length, `[${vector.join(',')}]`, model],
          )
        ).rows[0].id;
        chunkIdByKey.set(chunk.key, id);
      }
    }
    await owner.query('analyze document_chunks');
  }, 900_000);

  afterAll(async () => {
    if (report.length) {
      const out = process.env.EVAL_OUT ?? 'eval-report.txt';
      writeFileSync(out, `${report.join('\n')}\n`);
    }
    if (owner) {
      await owner.query(`delete from workspaces where name = 'eval-golden'`);
      await owner.end();
    }
    if (pool) await pool.end();
  });

  it('scores hybrid retrieval against each leg alone', async () => {
    const ranking = { hybrid: [] as Array<{ retrieved: string[]; relevant: string[] }>, vector: [] as Array<{ retrieved: string[]; relevant: string[] }>, fts: [] as Array<{ retrieved: string[]; relevant: string[] }> };
    const byKind = new Map<string, Scored>();
    const perKind: Record<string, { hybrid: typeof ranking.hybrid; vector: typeof ranking.hybrid; fts: typeof ranking.hybrid }> = {};

    for (const c of EVAL_CASES) {
      if (c.kind === 'refusal') continue; // scored separately below
      const relevant = c.relevantKeys.map((k) => chunkIdByKey.get(k)!);
      const response = await retrieval.search(workspaceId, { query: c.question, topK: TOP_K, debug: true });

      const hybrid = response.results.map((r) => r.chunkId);
      const vector = response.results
        .filter((r) => r.signals?.vector)
        .sort((a, b) => a.signals!.vector!.rank - b.signals!.vector!.rank)
        .map((r) => r.chunkId);
      const fts = response.results
        .filter((r) => r.signals?.fts)
        .sort((a, b) => a.signals!.fts!.rank - b.signals!.fts!.rank)
        .map((r) => r.chunkId);

      ranking.hybrid.push({ retrieved: hybrid, relevant });
      ranking.vector.push({ retrieved: vector, relevant });
      ranking.fts.push({ retrieved: fts, relevant });
      perKind[c.kind] ??= { hybrid: [], vector: [], fts: [] };
      perKind[c.kind].hybrid.push({ retrieved: hybrid, relevant });
      perKind[c.kind].vector.push({ retrieved: vector, relevant });
      perKind[c.kind].fts.push({ retrieved: fts, relevant });
    }

    const overall: Scored = {
      hybrid: aggregate(ranking.hybrid, REPORT_AT_K),
      vector: aggregate(ranking.vector, REPORT_AT_K),
      fts: aggregate(ranking.fts, REPORT_AT_K),
    };

    report.push(`RAG retrieval evaluation — ${new Date().toISOString()}`);
    report.push(`corpus: ${EVAL_DOCUMENTS.reduce((n, d) => n + d.chunks.length, 0)} chunks / ${EVAL_DOCUMENTS.length} documents`);
    report.push(`model: ${process.env.EMBEDDING_MODEL ?? 'snowflake-arctic-embed:110m'}, topK=${TOP_K}, metrics @${REPORT_AT_K}`);
    report.push(...table('OVERALL', [['hybrid (RRF)', overall.hybrid], ['vector only', overall.vector], ['keyword only', overall.fts]]));

    for (const kind of ['semantic', 'lexical', 'both'] as const) {
      if (!perKind[kind]) continue;
      const s: Scored = {
        hybrid: aggregate(perKind[kind].hybrid, REPORT_AT_K),
        vector: aggregate(perKind[kind].vector, REPORT_AT_K),
        fts: aggregate(perKind[kind].fts, REPORT_AT_K),
      };
      byKind.set(kind, s);
      report.push(...table(`BY KIND: ${kind}`, [['hybrid (RRF)', s.hybrid], ['vector only', s.vector], ['keyword only', s.fts]]));
    }

    console.log(report.join('\n'));

    // The harness must actually retrieve something, or the report is noise.
    expect(overall.hybrid.cases).toBeGreaterThan(0);
    expect(overall.hybrid.recallAtK, 'hybrid retrieval should find most labelled answers').toBeGreaterThan(0.5);
    // The architectural claim, asserted: fusion must not be WORSE than either
    // leg alone. If this ever fails, hybrid search is not earning its latency.
    expect(overall.hybrid.recallAtK).toBeGreaterThanOrEqual(Math.max(overall.vector.recallAtK, overall.fts.recallAtK) - 0.001);
  }, 900_000);

  it('retrieves nothing convincing for questions the corpus cannot answer', async () => {
    // The refusal cases are not a ranking problem. What matters is that the
    // top hit is not a confident near-miss: Phase 5 refuses on ZERO hits, so
    // anything retrieved here goes to the model as if it were an answer. This
    // is the measurement behind the weak-hits refusal threshold that Phase 5
    // deferred to this phase.
    const lines: string[] = ['', 'REFUSAL CASES (top-1 distance — the weak-hits signal)'];
    for (const c of EVAL_CASES.filter((x) => x.kind === 'refusal')) {
      const response = await retrieval.search(workspaceId, { query: c.question, topK: 3, debug: true });
      const top = response.results[0];
      const distance = top?.signals?.vector?.distance;
      lines.push(`  ${c.id.padEnd(7)} hits=${response.results.length}  top-1 distance=${distance === undefined ? 'n/a' : distance.toFixed(4)}  "${top?.content.slice(0, 48) ?? '-'}…"`);
    }
    report.push(...lines);
    console.log(lines.join('\n'));
    expect(lines.length).toBeGreaterThan(2);
  }, 900_000);
});
