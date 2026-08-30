import { Inject, Injectable } from '@nestjs/common';
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
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly embeddings: EmbeddingService,
  ) {}

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
   * `latest_versions` restricts retrieval to the newest indexed version of
   * each document — re-uploading a document leaves the old version's rows
   * 'indexed' (status transitions are Phase 3's last-write-wins shortcut), and
   * without this filter a query would return near-duplicate chunks from every
   * version ever indexed.
   *
   * The explicit workspace predicate is the application-level filter; the RLS
   * policy is the backstop beneath it. Both, always.
   */
  private async vectorLeg(tx: Tx, workspaceId: string, queryVector: string, documentId?: string): Promise<VectorCandidate[]> {
    const result = await tx.execute(sql`
      with latest_versions as (
        select distinct on (document_id) id, document_id
        from document_versions
        where workspace_id = ${workspaceId}::uuid and status = 'indexed'
        order by document_id, created_at desc
      )
      select
        c.id,
        c.chunk_index as "chunkIndex",
        c.content,
        c.char_start as "charStart",
        c.char_end as "charEnd",
        lv.document_id as "documentId",
        d.title as "documentTitle",
        c.embedding <=> ${queryVector}::vector as "distance"
      from document_chunks c
      join latest_versions lv on lv.id = c.document_version_id
      join documents d on d.id = lv.document_id
      where c.workspace_id = ${workspaceId}::uuid
        and c.embedding is not null
        ${documentId ? sql`and lv.document_id = ${documentId}::uuid` : sql``}
      order by c.embedding <=> ${queryVector}::vector
      limit ${CANDIDATES_PER_SIGNAL}
    `);
    return result.rows as unknown as VectorCandidate[];
  }

  /**
   * Keyword leg: Postgres full-text search over the generated tsvector column.
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
        order by document_id, created_at desc
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
