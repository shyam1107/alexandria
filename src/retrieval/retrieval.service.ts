import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { sql } from 'drizzle-orm';
import type { Db } from '../database/database.module';
import { DRIZZLE } from '../database/database.module';
import { withWorkspace, type Tx } from '../database/tenant';
import { EmbeddingService } from '../ingestion/embedding.service';
import { rrfMerge } from './rrf';
import type { SearchDto } from './dto/search.dto';

/**
 * Candidates fetched per signal before fusion. Deep pools cost little (an
 * HNSW top-N and a GIN lookup are both cheap) and give RRF enough overlap to
 * matter: a chunk ranked 40th by one signal and 5th by the other still
 * surfaces. Tune with the Phase 8 eval harness, not by intuition.
 */
const CANDIDATES_PER_SIGNAL = 50;

interface VectorCandidate {
  id: string;
  chunkIndex: number;
  content: string;
  charStart: number | null;
  charEnd: number | null;
  documentId: string;
  documentTitle: string;
  distance: number;
}

interface FtsCandidate {
  id: string;
  chunkIndex: number;
  content: string;
  charStart: number | null;
  charEnd: number | null;
  documentId: string;
  documentTitle: string;
  rank: number;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  charStart: number | null;
  charEnd: number | null;
  score: number;
  signals?: {
    vector?: { rank: number; distance: number };
    fts?: { rank: number; score: number };
  };
}

@Injectable()
export class RetrievalService {
  private readonly efSearch: number;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly embeddings: EmbeddingService,
    config: ConfigService<Env, true>,
  ) {
    this.efSearch = config.get('HNSW_EF_SEARCH', { infer: true });
  }

  async search(workspaceId: string, dto: SearchDto) {
    const topK = dto.topK ?? 10;
    // If the embedding provider is down the whole search fails — deliberate.
    // Degrading silently to FTS-only would hide the outage behind slightly
    // worse answers served through the same SSE grammar with the same
    // citation chips: "search got subtly worse on Tuesday" is an incident
    // nobody could reconstruct. Retries and timeouts live in
    // EmbeddingService; a persistent outage presents as one (HTTP 502 before
    // the first frame). An EXPLICIT degraded mode (marker in the sources
    // frame) is a Phase 7 design.
    const queryVector = `[${(await this.embeddings.embed(dto.query, { workspaceId, operation: 'embedding_query' })).join(',')}]`;

    const { vectorRows, ftsRows } = await withWorkspace(this.db, workspaceId, async (tx) => {
      const vectorRows = await this.vectorLeg(tx, workspaceId, queryVector, dto.documentId);
      const ftsRows = await this.ftsLeg(tx, workspaceId, dto.query, dto.documentId);
      return { vectorRows, ftsRows };
    });

    const merged = rrfMerge<VectorCandidate | FtsCandidate>([vectorRows, ftsRows]);
    const vectorById = new Map(vectorRows.map((row) => [row.id, row]));
    const ftsById = new Map(ftsRows.map((row) => [row.id, row]));

    const results: SearchHit[] = merged.slice(0, topK).map((hit) => {
      const base = vectorById.get(hit.item.id) ?? ftsById.get(hit.item.id)!;
      const vectorRank = hit.ranks[0];
      const ftsRank = hit.ranks[1];
      return {
        chunkId: base.id,
        documentId: base.documentId,
        documentTitle: base.documentTitle,
        chunkIndex: base.chunkIndex,
        content: base.content,
        charStart: base.charStart,
        charEnd: base.charEnd,
        score: hit.score,
        signals: dto.debug
          ? {
              ...(vectorRank !== null ? { vector: { rank: vectorRank, distance: vectorById.get(hit.item.id)!.distance } } : {}),
              ...(ftsRank !== null ? { fts: { rank: ftsRank, score: ftsById.get(hit.item.id)!.rank } } : {}),
            }
          : undefined,
      };
    });

    return {
      query: dto.query,
      topK,
      results,
      ...(dto.debug ? { debug: { candidates: { vector: vectorRows.length, fts: ftsRows.length }, embeddingModel: this.embeddings.modelName } } : {}),
    };
  }

  /**
   * Semantic leg: nearest neighbours by cosine distance over the HNSW index.
   *
   * TWO PHASES, and the split is load-bearing — verified empirically on the
   * pgvector 0.8.4 image (see workflow doc 08 and the
   * `finds chunks ranked below the global HNSW cut` test):
   *
   * Phase 1 resolves the latest indexed version of each document into a list
   * of version ids. Phase 2 passes that list as a *parameter array* to the
   * vector scan, with the workspace predicate, as scan-level filters, and the
   * LIMIT directly above the index scan. Enrichment joins (title lookup) run
   * OUTSIDE the limited subquery.
   *
   * Why not one query with a JOIN against latest_versions — the Phase 4 shape?
   * The HNSW index scan finds the GLOBAL top-k candidates and Postgres applies
   * tenant/version filters *afterwards* (post-filtering): a workspace whose
   * best chunks sit below the global cut gets short results or none at all —
   * a recall failure that grows as tenant count grows, invisible on a dev
   * corpus with one workspace. pgvector's `iterative_scan` fixes exactly
   * this, but ONLY when the LIMIT sits directly above the index scan: a JOIN
   * (or semi-join) between the two breaks the scan's iteration loop — measured,
   * not assumed: with a join shape the post-fix query returned 50 filler
   * rows while missing the workspace's best chunk entirely. A wrong answer
   * that looks right is the worst possible failure mode for retrieval.
   *
   * `relaxed_order` lets an iteration yield rows in scan order rather than
   * strict distance order; we re-sort the ≤50 survivors by distance here so
   * RRF ranks stay meaningful. The re-sort is trivial (50 rows).
   *
   * `SET LOCAL`, not session-level: the GUCs are transaction-scoped, so they
   * can never leak to another request on a pooled connection — same reason
   * `withWorkspace()` sets the tenant GUC transaction-locally. Verified
   * transaction-local on a cold backend too: the placeholder GUC is adopted
   * when the vector library loads mid-transaction.
   *
   * ef_search is the visit budget per iteration. Iteration fixes starvation
   * (0 results); ef_search governs how deep each pass reaches. A chunk ranked
   * behind ef_search * per-iteration count of foreign chunks can still be
   * missed — the honest limitation, documented in doc 12 — but per-workspace
   * partial indexes / table partitioning are the scale answer, not more
   * ef_search (hard cap 1000).
   *
   * The explicit workspace predicate is the application-level filter; the RLS
   * policy is the backstop beneath it. Both, always.
   */
  private async vectorLeg(tx: Tx, workspaceId: string, queryVector: string, documentId?: string): Promise<VectorCandidate[]> {
    // Phase 1: latest indexed version per document. `id desc` is the
    // tiebreaker — two versions sharing a created_at made the winner
    // nondeterministic; a total order costs nothing and stops the flapping.
    const latest = documentId
      ? await tx.execute(sql`select distinct on (document_id) id from document_versions where workspace_id = ${workspaceId}::uuid and status = 'indexed' and document_id = ${documentId}::uuid order by document_id, created_at desc, id desc`)
      : await tx.execute(sql`select distinct on (document_id) id from document_versions where workspace_id = ${workspaceId}::uuid and status = 'indexed' order by document_id, created_at desc, id desc`);
    const versionIds = (latest.rows as Array<{ id: string }>).map((row) => row.id);
    if (versionIds.length === 0) return [];

    await tx.execute(sql`select set_config('hnsw.ef_search', ${String(this.efSearch)}, true)`);
    await tx.execute(sql`select set_config('hnsw.iterative_scan', 'relaxed_order', true)`);

    // Phase 2: LIMIT directly above the index scan; version ids as a
    // parameter array (scan-level predicate), enrichment outside.
    // sql.param() binds the JS array as ONE parameter (node-postgres
    // serializes it to a Postgres array); interpolating the array bare
    // would expand it into a parameter list for an IN clause and break
    // the = any() shape. The ids come from our own phase-1 query —
    // DB-generated uuids — but parameterized stays the house rule.
    const versionArray = sql.param(versionIds);
    const result = await tx.execute(sql`
      with ranked as (
        select c.id, c.chunk_index, c.content, c.char_start, c.char_end, c.document_version_id,
               c.embedding <=> ${queryVector}::vector as distance
        from document_chunks c
        where c.workspace_id = ${workspaceId}::uuid
          and c.document_version_id = any(${versionArray}::uuid[])
          and c.embedding is not null
        order by distance
        limit ${CANDIDATES_PER_SIGNAL}
      )
      select
        r.id,
        r.chunk_index as "chunkIndex",
        r.content,
        r.char_start as "charStart",
        r.char_end as "charEnd",
        lv.document_id as "documentId",
        d.title as "documentTitle",
        r.distance
      from ranked r
      join document_versions lv on lv.id = r.document_version_id
      join documents d on d.id = lv.document_id
      order by r.distance asc
    `);
    return result.rows as unknown as VectorCandidate[];
  }

  /**
   * Keyword leg: Postgres full-text search over the generated tsvector column.
   *
   * `latest_versions` here keeps the one-query shape: the GIN scan is not an
   * ANN scan — there is no global top-k cut to fall off of, so
   * post-filtering is safe on this leg and no iterative-scan restructuring is
   * needed. It still gets the `id desc` tiebreaker: two versions sharing a
   * created_at must not make "latest" nondeterministic.
   *
   * websearch_to_tsquery (not to_tsquery): it accepts natural user input —
   * quotes, OR, minus — and, critically, never raises a syntax error on junk.
   * A stopword-only query ("what is the") produces an empty tsquery, the @@
   * predicate matches nothing, and the vector leg carries the search alone;
   * hybrid means either leg may legitimately come back empty.
   */
  private async ftsLeg(tx: Tx, workspaceId: string, queryText: string, documentId?: string): Promise<FtsCandidate[]> {
    const result = await tx.execute(sql`
      with latest_versions as (
        select distinct on (document_id) id, document_id
        from document_versions
        where workspace_id = ${workspaceId}::uuid and status = 'indexed'
        order by document_id, created_at desc, id desc
      ),
      q as (select websearch_to_tsquery('english', ${queryText}) as tsq)
      select
        c.id,
        c.chunk_index as "chunkIndex",
        c.content,
        c.char_start as "charStart",
        c.char_end as "charEnd",
        lv.document_id as "documentId",
        d.title as "documentTitle",
        ts_rank(c.search_vector, q.tsq) as "rank"
      from document_chunks c
      join latest_versions lv on lv.id = c.document_version_id
      join documents d on d.id = lv.document_id
      cross join q
      where c.workspace_id = ${workspaceId}::uuid
        and c.search_vector @@ q.tsq
        ${documentId ? sql`and lv.document_id = ${documentId}::uuid` : sql``}
      order by "rank" desc
      limit ${CANDIDATES_PER_SIGNAL}
    `);
    return result.rows as unknown as FtsCandidate[];
  }
}
