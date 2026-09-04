/**
 * Ranking metrics for the retrieval evaluation harness.
 *
 * Pure functions over ids: they know nothing about vectors, Postgres or
 * chunks, which is what makes them unit-testable against worked examples
 * instead of "it ran and produced a number". Every RAG project reports
 * recall@k; far fewer can show the arithmetic is right.
 *
 * All metrics take BINARY relevance (a chunk is relevant or it is not).
 * Graded relevance would be more expressive and is not worth it here: the
 * labels are hand-made, and asking a human to distinguish "quite relevant"
 * from "very relevant" produces noise, not signal.
 */

/** One labelled question: what was asked, and which chunks should come back. */
export interface EvalCase {
  id: string;
  question: string;
  /** Chunk ids that genuinely answer the question. Empty = should refuse. */
  relevantChunkIds: string[];
  /** Free-text note explaining WHY these are the answers — for the reader. */
  note?: string;
}

/**
 * Fraction of the relevant chunks that appear in the top k.
 *
 * The headline RAG metric, because a generator cannot cite what retrieval
 * never handed it: recall@k is the ceiling on answer quality. Precision
 * matters far less — an extra irrelevant chunk costs context budget, a
 * missing relevant one costs the answer.
 *
 * Undefined when nothing is relevant; returns null so callers must decide
 * rather than silently averaging a 0 or a 1 into the corpus score.
 */
export function recallAtK(retrieved: string[], relevant: string[], k: number): number | null {
  if (relevant.length === 0) return null;
  const top = new Set(retrieved.slice(0, k));
  const found = relevant.filter((id) => top.has(id)).length;
  return found / relevant.length;
}

/** Fraction of the top k that is relevant. Reported for context, not tuned on. */
export function precisionAtK(retrieved: string[], relevant: string[], k: number): number | null {
  if (k <= 0) return null;
  const relevantSet = new Set(relevant);
  const top = retrieved.slice(0, k);
  if (top.length === 0) return 0;
  return top.filter((id) => relevantSet.has(id)).length / k;
}

/**
 * Reciprocal rank of the FIRST relevant result: 1, 1/2, 1/3 … or 0.
 *
 * Answers "how far down did the user have to look", which is the question
 * that matters when a generator only reads the top few chunks. Averaged over
 * cases this is MRR.
 *
 * This is the unbounded form — it searches the entire retrieved list. The
 * aggregate uses `reciprocalRankAtK` instead, because every other metric in
 * the report table is computed at k and the table header says `@5`. MRR over
 * the full list would silently credit a hit at position 50 in a top-5 report,
 * making the number inconsistent with its neighbours.
 */
export function reciprocalRank(retrieved: string[], relevant: string[]): number {
  const relevantSet = new Set(relevant);
  const index = retrieved.findIndex((id) => relevantSet.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

/**
 * Reciprocal rank truncated at k: the first relevant result must appear
 * within the top k, or the score is 0. This is the form the aggregate uses,
 * because the eval report labels every column `@5` and an MRR that searches
 * beyond the cut is answering a different question than the column promises.
 */
export function reciprocalRankAtK(retrieved: string[], relevant: string[], k: number): number {
  const relevantSet = new Set(relevant);
  const index = retrieved.slice(0, k).findIndex((id) => relevantSet.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

/**
 * Normalised discounted cumulative gain at k, binary gains.
 *
 * Unlike recall it is rank-sensitive: finding the answer at position 1 scores
 * higher than finding it at position 8, which is exactly the difference a
 * re-ranker is supposed to make. That is why this metric decides whether
 * Phase 8's re-ranking work is worth its latency.
 *
 * The subtlety worth stating: the ideal DCG is computed over
 * min(relevant, k) items, not over all relevant items. Normalising against an
 * unreachable ideal would cap a perfect ranking below 1.0 whenever there are
 * more relevant chunks than slots, and the metric would silently punish
 * nothing.
 */
export function ndcgAtK(retrieved: string[], relevant: string[], k: number): number | null {
  if (relevant.length === 0) return null;
  const relevantSet = new Set(relevant);
  const discount = (rank: number) => 1 / Math.log2(rank + 2); // rank is 0-based
  const dcg = retrieved.slice(0, k).reduce((sum, id, i) => sum + (relevantSet.has(id) ? discount(i) : 0), 0);
  const idealHits = Math.min(relevant.length, k);
  const idcg = Array.from({ length: idealHits }, (_, i) => discount(i)).reduce((a, b) => a + b, 0);
  return idcg === 0 ? null : dcg / idcg;
}

/** 1 if any relevant chunk is in the top k. The "did it work at all" metric. */
export function hitRateAtK(retrieved: string[], relevant: string[], k: number): number | null {
  if (relevant.length === 0) return null;
  const relevantSet = new Set(relevant);
  return retrieved.slice(0, k).some((id) => relevantSet.has(id)) ? 1 : 0;
}

export interface AggregateScores {
  cases: number;
  recallAtK: number;
  precisionAtK: number;
  mrr: number;
  ndcgAtK: number;
  hitRate: number;
}

/**
 * Macro-averages each metric over the cases that define it.
 *
 * Macro, not micro: every question counts once regardless of how many chunks
 * happen to answer it. A micro average lets one heavily-labelled question
 * dominate the corpus score, which then moves when you add labels rather than
 * when retrieval changes.
 *
 * Cases with no relevant chunks (the should-refuse ones) are excluded here —
 * they are not a ranking question, and they are scored separately by the
 * refusal check. Averaging them in as 0 would make a correct refusal look
 * like a retrieval failure.
 */
export function aggregate(results: Array<{ retrieved: string[]; relevant: string[] }>, k: number): AggregateScores {
  const scored = results.filter((r) => r.relevant.length > 0);
  const mean = (values: Array<number | null>) => {
    const present = values.filter((v): v is number => v !== null);
    return present.length === 0 ? 0 : present.reduce((a, b) => a + b, 0) / present.length;
  };
  return {
    cases: scored.length,
    recallAtK: mean(scored.map((r) => recallAtK(r.retrieved, r.relevant, k))),
    precisionAtK: mean(scored.map((r) => precisionAtK(r.retrieved, r.relevant, k))),
    mrr: mean(scored.map((r) => reciprocalRankAtK(r.retrieved, r.relevant, k))),
    ndcgAtK: mean(scored.map((r) => ndcgAtK(r.retrieved, r.relevant, k))),
    hitRate: mean(scored.map((r) => hitRateAtK(r.retrieved, r.relevant, k))),
  };
}
