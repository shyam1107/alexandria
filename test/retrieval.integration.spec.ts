import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/database/schema';
import { RetrievalService } from '../src/retrieval/retrieval.service';
import type { EmbeddingService } from '../src/ingestion/embedding.service';

/**
 * Retrieval is where tenant isolation stops being a policy detail and becomes
 * the product: a search that leaks one row from another workspace leaks that
 * workspace's content into an LLM prompt. So these tests run the real
 * RetrievalService against the real database **as the runtime role** — RLS
 * active — with a stubbed embedding provider, because ranking by hand-crafted
 * vectors is deterministic in a way a live model never is.
 *
 * Vector fixture: one-hot 768-dim basis vectors. Identical content gets the
 * identical basis vector, orthogonal content an orthogonal one — so expected
 * cosine distances are exact, not approximate.
 */

const DIMENSIONS = 768;
const basis = (dim: number) => {
  const v = new Array<number>(DIMENSIONS).fill(0);
  v[dim] = 1;
  return `[${v.join(',')}]`;
};
// Nearly basis(0) but not exactly: cosine distance ≈ 0.005 from the query
// vector, so vector-leg ranks among the refund-ish chunks are deterministic
// rather than whatever order a distance tie happens to fall out in.
const tilted = () => {
  const v = new Array<number>(DIMENSIONS).fill(0);
  v[0] = 1;
  v[1] = 0.1;
  return `[${v.join(',')}]`;
};

// 'refund policy' text <-> basis(0); 'shipping window' text <-> basis(1).
const stubEmbeddings = {
  embed: async (text: string) => (text.includes('shipping') ? basis(1) : basis(0)).slice(1, -1).split(',').map(Number),
  modelName: 'test-embedding-model',
} as unknown as EmbeddingService;

describe('retrieval (integration)', () => {
  let owner: Client;
  let pool: Pool;
  let retrieval: RetrievalService;
  let workspaceA: string;
  let workspaceB: string;
  let docRefund: string;
  let docShipping: string;
  let docVersioned: string;

  async function seedDocument(workspaceId: string, title: string, versions: Array<{ status: string; chunks: Array<{ index: number; content: string; vector: string }> }>) {
    const documentId = (await owner.query(`insert into documents (workspace_id, title, status) values ($1, $2, 'indexed') returning id`, [workspaceId, title])).rows[0].id;
    for (const [i, version] of versions.entries()) {
      // created_at spaced so "latest indexed version" is deterministic.
      const versionId = (
        await owner.query(
          `insert into document_versions (document_id, workspace_id, object_key, original_filename, content_type, byte_size, status, created_at)
           values ($1, $2, $3, $4, 'text/plain', 100, $5, now() + ($6 || ' minutes')::interval) returning id`,
          [documentId, workspaceId, `k/${documentId}/${i}`, `${title}.txt`, version.status, String(i)],
        )
      ).rows[0].id;
      for (const chunk of version.chunks) {
        await owner.query(
          `insert into document_chunks (document_version_id, workspace_id, chunk_index, content, char_start, char_end, embedding, embedding_model)
           values ($1, $2, $3, $4, 0, $5, $6::vector, 'test-embedding-model')`,
          [versionId, workspaceId, chunk.index, chunk.content, chunk.content.length, chunk.vector],
        );
      }
    }
    return documentId;
  }

  beforeAll(async () => {
    const ownerUrl = process.env.MIGRATION_DATABASE_URL;
    const appUrl = process.env.DATABASE_URL;
    if (!ownerUrl || !appUrl) throw new Error('DATABASE_URL and MIGRATION_DATABASE_URL must be set. Copy .env.example to .env.');
    owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    pool = new Pool({ connectionString: appUrl, max: 2 });
    retrieval = new RetrievalService(drizzle(pool, { schema }), stubEmbeddings);

    workspaceA = (await owner.query(`insert into workspaces (name) values ('retrieval-spec-a') returning id`)).rows[0].id;
    workspaceB = (await owner.query(`insert into workspaces (name) values ('retrieval-spec-b') returning id`)).rows[0].id;

    docRefund = await seedDocument(workspaceA, 'Refund policy', [
      { status: 'indexed', chunks: [{ index: 0, content: 'Our refund policy covers returned items within thirty days', vector: basis(0) }] },
    ]);
    docShipping = await seedDocument(workspaceA, 'Shipping guide', [
      { status: 'indexed', chunks: [{ index: 0, content: 'Shipping takes three to five business days per delivery window', vector: basis(1) }] },
    ]);
    // Same text, same vector as workspace A's refund chunk: if isolation is
    // policy-deep rather than real, this row is the one that leaks.
    await seedDocument(workspaceB, 'B refund policy', [
      { status: 'indexed', chunks: [{ index: 0, content: 'Our refund policy covers returned items within thirty days', vector: basis(0) }] },
    ]);
    docVersioned = await seedDocument(workspaceA, 'Versioned handbook', [
      // The stale chunk keeps basis(0) — distance 0 to the query — so only the
      // latest-version filter, not ranking luck, keeps it out of the results.
      { status: 'indexed', chunks: [{ index: 0, content: 'stale refund instructions from the old handbook', vector: basis(0) }] },
      { status: 'indexed', chunks: [{ index: 0, content: 'fresh refund instructions from the current handbook', vector: tilted() }] },
    ]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query(`delete from workspaces where name in ('retrieval-spec-a', 'retrieval-spec-b')`);
      await owner.end();
    }
    if (pool) await pool.end();
  });

  it('finds the semantically nearest chunk and reports the winning signals', async () => {
    const response = await retrieval.search(workspaceA, { query: 'refund policy', topK: 5, debug: true });
    expect(response.results.length).toBeGreaterThan(0);
    const [top] = response.results;
    expect(top.documentId).toBe(docRefund);
    // Both legs found it: vector distance 0, FTS rank 1 — the RRF sum of two
    // signals is what puts it above the one-leg competitors.
    expect(top.signals?.vector?.rank).toBe(1);
    expect(top.signals?.vector?.distance).toBeCloseTo(0);
    expect(top.signals?.fts?.rank).toBe(1);
    expect(response.debug?.candidates.vector).toBeGreaterThan(0);
  });

  it('never returns another workspace’s chunks, however similar the content', async () => {
    const response = await retrieval.search(workspaceA, { query: 'refund policy', topK: 10, debug: true });
    const docIds = new Set(response.results.map((r) => r.documentId));
    // Every seeded document in workspace A is fair game; workspace B's is not.
    for (const id of docIds) expect([docRefund, docShipping, docVersioned]).toContain(id);
    // The near-duplicate in B scored 0 distance in vector space; if the WHERE
    // clause or the RLS policy ever goes missing, this assertion catches it.
    expect(response.results.some((r) => r.documentTitle === 'B refund policy')).toBe(false);
  });

  it('returns only the latest indexed version of a document', async () => {
    const response = await retrieval.search(workspaceA, { query: 'refund policy', topK: 10 });
    const contents = response.results.map((r) => r.content);
    expect(contents).toContain('fresh refund instructions from the current handbook');
    expect(contents).not.toContain('stale refund instructions from the old handbook');
  });

  it('restricts retrieval to a single document when documentId is given', async () => {
    const response = await retrieval.search(workspaceA, { query: 'shipping window', topK: 5, documentId: docShipping });
    expect(response.results.length).toBeGreaterThan(0);
    for (const hit of response.results) expect(hit.documentId).toBe(docShipping);
  });

  it('survives a stopword-only query on the strength of the vector leg', async () => {
    // websearch_to_tsquery('english', 'what is the') is an empty tsquery: the
    // FTS leg returns nothing, hybrid still answers.
    const response = await retrieval.search(workspaceA, { query: 'what is the', topK: 3, debug: true });
    expect(response.debug?.candidates.fts).toBe(0);
    expect(response.results.length).toBeGreaterThan(0);
  });

  it('ranks a two-signal chunk above a one-signal chunk', async () => {
    const response = await retrieval.search(workspaceA, { query: 'refund policy', topK: 10 });
    // The shipping chunk is orthogonal to the query (vector distance 1) and
    // invisible to FTS, so it must sit below every chunk either signal liked.
    const shippingIndex = response.results.findIndex((r) => r.documentId === docShipping);
    const refundIndex = response.results.findIndex((r) => r.documentId === docRefund);
    expect(refundIndex).toBeGreaterThanOrEqual(0);
    if (shippingIndex !== -1) expect(refundIndex).toBeLessThan(shippingIndex);
  });
});
