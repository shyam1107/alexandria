-- Phase 4: make document_chunks actually searchable.
--
-- Three changes:
--
--   1. search_vector becomes a STORED generated tsvector. It was a `text`
--      column into which the worker wrote a second copy of `content` —
--      double storage, never converted to a tsvector, free to drift out of
--      sync. Postgres now derives it, so the two cannot disagree. The
--      two-argument to_tsvector('english', ...) is IMMUTABLE (unlike the
--      one-argument form, which reads default_text_search_config and is only
--      STABLE), which STORED generated columns and expression indexes require.
--      Trade-off: the 'english' regconfig (stemmer + stopwords) is baked into
--      the column definition; a multilingual corpus needs per-language
--      configs or 'simple' instead. Adding a STORED column rewrites the table
--      — free in dev, an online-migration exercise at production scale.
--
--   2. char_start/char_end record where each chunk lives in the parser's
--      ORIGINAL output, before the chunker's whitespace normalization.
--      Phase 5 citations slice the source with them; they cannot be
--      reconstructed from the stored (normalized) content. Nullable because
--      rows ingested before this migration have none — the dev corpus gets
--      re-ingested rather than backfilled.
--
--   3. The embedding column finally gets an index. HNSW over IVFFlat: no
--      training pass, no recall decay as the table grows, and better
--      recall/latency until well past a million vectors; the price is build
--      time and ~1.5-2x the column's memory. Defaults m=16, ef_construction=64;
--      ef_search stays a per-query SET LOCAL knob. vector_cosine_ops because
--      embedding direction carries the semantics (and nomic-embed-text
--      vectors are near-normalized anyway, where cosine ~= dot).

ALTER TABLE "document_chunks" drop column "search_vector";--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "char_start" integer;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "char_end" integer;--> statement-breakpoint
CREATE INDEX "document_chunks_embedding_hnsw_idx" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "document_chunks_search_vector_gin_idx" ON "document_chunks" USING gin ("search_vector");