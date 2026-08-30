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

// RetrievalService now reads HNSW_EF_SEARCH from config; the suite pins it
// the way production pins it — as an env value, not a hardcoded number.
const configStub = () =>
  ({
    get: (key: string) => {
      if (key === 'HNSW_EF_SEARCH') return 80;
      throw new Error(`config stub asked for unexpected key ${key}`);
    },
  }) as never;

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
    retrieval = new RetrievalService(drizzle(pool, { schema }), stubEmbeddings, configStub());

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

  /**
   * THE HNSW POST-FILTER RECALL TRAP (the Phase 7 backlog item, fixed).
   *
   * An HNSW scan returns the GLOBAL top-k; tenant filters apply afterwards.
   * A workspace whose best chunks sit below the global cut — because another
   * tenant's near-identical chunks crowd the ranking — got short results or
   * none at all before the iterative-scan fix, and the failure worsens as
   * tenant count grows.
   *
   * The fixture must satisfy two non-negotiables, both learned the hard way
   * while validating the fix against the real pgvector image:
   *
   * 1. The query plan must actually use the HNSW index. At fixture scale the
   *    planner prefers sort-based plans, which mask the trap entirely (the
   *    pre-fix query then returns correct results for the wrong reason).
   *    `set_config('enable_sort', 'off')` makes the production plan shape —
   *    HNSW ordered index scan — deterministic at fixture scale.
   *
   * 2. The needle must be REACHABLE in the HNSW graph. The one-hot "basis"
   *    vectors used elsewhere in this suite are graph-isolated outliers with
   *    no inbound edges — HNSW cannot return them regardless of settings, so
   *    a needle built that way measures nothing. Instead all vectors here
   *    share a line manifold, e0 + t*e1 with continuously varying t, which
   *    is what real embedding manifolds look like and what HNSW's
   *    connectivity assumptions are built on.
   *
   * Geometry: the foreign workspace holds 140 chunks at t = 0.0001..0.0140
   * (all closer to the query than the target's chunks — they occupy the
   * global top-k cut); the target workspace holds 31 chunks at
   * t = 0.02..0.05. The target's best chunk (t=0.02, content
   * 'needle-content-zero') sits at global rank 141 — well below the global
   * top-50 cut. Pre-fix, the vector leg returned ZERO rows for the target
   * workspace: total starvation. Post-fix (iterative scan), all 31 surface.
   *
   * Proven to bite: reverting vectorLeg to the join shape and dropping the
   * GUCs makes this test fail with zero vector results.
   */
  it('finds chunks ranked below the global HNSW cut (post-filter recall trap)', async () => {
    const lineVector = (t: number) => {
      const v = new Array<number>(DIMENSIONS).fill(0);
      v[0] = 1;
      v[1] = t;
      return `[${v.join(',')}]`;
    };

    // Foreign workspace: 140 chunks crowding the global top-k.
    const wsCrowd = (await owner.query(`insert into workspaces (name) values ('retrieval-hnsw-crowd') returning id`)).rows[0].id;
    const crowdDoc = (await owner.query(`insert into documents (workspace_id, title, status) values ($1, 'crowd doc', 'indexed') returning id`, [wsCrowd])).rows[0].id;
    const crowdVersion = (
      await owner.query(
        `insert into document_versions (document_id, workspace_id, object_key, original_filename, content_type, byte_size, status)
         values ($1, $2, 'k/crowd', 'crowd.txt', 'text/plain', 100, 'indexed') returning id`,
        [crowdDoc, wsCrowd],
      )
    ).rows[0].id;
    for (let g = 0; g < 140; g++) {
      await owner.query(
        `insert into document_chunks (document_version_id, workspace_id, chunk_index, content, char_start, char_end, embedding, embedding_model)
         values ($1, $2, $3, $4, 0, 20, $5::vector, 'test-embedding-model')`,
        [crowdVersion, wsCrowd, g, `crowd filler ${g}`, lineVector(0.0001 * (g + 1))],
      );
    }

    // Target workspace: 31 chunks, ALL ranked below the global cut.
    const wsTarget = (await owner.query(`insert into workspaces (name) values ('retrieval-hnsw-target') returning id`)).rows[0].id;
    const targetDoc = (await owner.query(`insert into documents (workspace_id, title, status) values ($1, 'target doc', 'indexed') returning id`, [wsTarget])).rows[0].id;
    const targetVersion = (
      await owner.query(
        `insert into document_versions (document_id, workspace_id, object_key, original_filename, content_type, byte_size, status)
         values ($1, $2, 'k/target', 'target.txt', 'text/plain', 100, 'indexed') returning id`,
        [targetDoc, wsTarget],
      )
    ).rows[0].id;
    for (let g = 0; g < 31; g++) {
      await owner.query(
        `insert into document_chunks (document_version_id, workspace_id, chunk_index, content, char_start, char_end, embedding, embedding_model)
         values ($1, $2, $3, $4, 0, 20, $5::vector, 'test-embedding-model')`,
        [targetVersion, wsTarget, g, g === 0 ? 'needle-content-zero' : `target filler ${g}`, lineVector(0.02 + 0.001 * g)],
      );
    }
    await owner.query(`analyze document_chunks`);

    // The trap fires only under the HNSW plan — at fixture scale the planner
    // prefers sort-based plans which mask it entirely. `enable_sort = off`
    // session-level on a dedicated ONE-connection pool makes every retrieval
    // query ride a connection where the HNSW ordered scan is the only plan:
    // deterministic, and the setting is scoped to this test's own pool.
    const trapPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const trapClient = await trapPool.connect();
    await trapClient.query(`set enable_sort = off`);
    trapClient.release();
    const stubbedQuery = {
      embed: async () => lineVector(0).slice(1, -1).split(',').map(Number),
      modelName: 'test-embedding-model',
    } as unknown as EmbeddingService;
    const trapRetrieval = new RetrievalService(drizzle(trapPool, { schema }), stubbedQuery, configStub());

    try {
      const response = await trapRetrieval.search(wsTarget, { query: 'needle query', topK: 50, debug: true });
      // Pre-fix this was 0: the workspace's ENTIRE corpus was below the
      // global cut, so the post-filtered scan starved.
      expect(response.debug?.candidates.vector).toBe(31);
      const contents = response.results.map((r) => r.content);
      expect(contents).toContain('needle-content-zero');
      // And the needle ranks first — the re-sort by distance after
      // relaxed_order keeps RRF ranks meaningful.
      expect(response.results[0].content).toBe('needle-content-zero');
    } finally {
      await trapPool.end();
      await owner.query(`delete from workspaces where id = any($1::uuid[])`, [[wsCrowd, wsTarget]]);
    }
  });

  /**
   * Two document versions sharing a created_at must not make "latest indexed
   * version" nondeterministic. Pre-fix, `distinct on` with tied keys picks an
   * ARBITRARY row — stable for a given physical layout (so it sneaks through
   * repeated in-process runs) but it flips across vacuums, rewrites and
   * replicas, and the probe against the real database showed it is simply
   * *not the max uuid*. The tiebreaker's contract is stronger than
   * "stable": the winner must be the max-id version, deterministically,
   * everywhere.
   *
   * Twenty tied versions make the arbitrary pick distinguishable from the
   * max-id pick with certainty — if the ORDER BY ignores ties, the scan's
   * first-encountered row is overwhelmingly unlikely to be the max uuid, and
   * the assertion names the exact version that must win.
   *
   * Proven to bite: reverting `order by ..., id desc` to
   * `order by ..., created_at desc` makes this test fail (arbitrary pick ≠
   * max-id version).
   */
  it('breaks created_at ties deterministically when picking the latest version', async () => {
    const ws = (await owner.query(`insert into workspaces (name) values ('retrieval-tiebreak') returning id`)).rows[0].id;
    const doc = (await owner.query(`insert into documents (workspace_id, title, status) values ($1, 'tie doc', 'indexed') returning id`, [ws])).rows[0].id;

    // 20 versions, IDENTICAL created_at, all 'indexed', each with its own
    // content; remember which version holds the max uuid.
    const sameInstant = new Date().toISOString();
    let maxId = '';
    for (let g = 0; g < 20; g++) {
      const content = `tiebreak content ${g}`;
      const versionId = (
        await owner.query(
          `insert into document_versions (document_id, workspace_id, object_key, original_filename, content_type, byte_size, status, created_at)
           values ($1, $2, $3, $4, 'text/plain', 100, 'indexed', $5) returning id`,
          [doc, ws, `k/${doc}/${g}`, `v${g}.txt`, sameInstant],
        )
      ).rows[0].id as string;
      if (versionId > maxId) {
        maxId = versionId;
      }
      await owner.query(
        `insert into document_chunks (document_version_id, workspace_id, chunk_index, content, char_start, char_end, embedding, embedding_model)
         values ($1, $2, 0, $3, 0, $4, $5::vector, 'test-embedding-model')`,
        [versionId, ws, content, content.length, basis(0)],
      );
    }
    const [maxVersion] = (await owner.query(`select id from document_versions where workspace_id = $1 and id = $2`, [ws, maxId])).rows;
    expect(maxVersion).toBeDefined();
    const { rows: [maxChunk] } = await owner.query(`select content from document_chunks where document_version_id = $1`, [maxId]);

    try {
      // The winner must be the max-id version's chunk — the contract of the
      // `id desc` tiebreaker, not merely "the same one every time".
      const response = await retrieval.search(ws, { query: 'tiebreak', topK: 10 });
      const contents = new Set(response.results.map((r) => r.content));
      expect(contents.size, 'both legs must return exactly one tied version').toBeLessThanOrEqual(1);
      expect(response.results[0]?.content).toBe(maxChunk.content);
    } finally {
      await owner.query(`delete from workspaces where id = $1::uuid`, [ws]);
    }
  });
});
