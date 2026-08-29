/**
 * Reciprocal Rank Fusion (Cormack, Clarke & Büttcher, SIGIR 2009).
 *
 * score(item) = Σ over each ranked list of  1 / (k + rank)   with rank 1-based.
 *
 * Why ranks and not scores: cosine distance (0..2) and ts_rank (0..~1,
 * query-dependent) live on incomparable scales that drift per query, so a
 * weighted sum needs per-query calibration to avoid one signal silently
 * dominating. RRF consumes only the *ordering* each signal produced, which is
 * the part each signal is actually confident about. Nothing to calibrate,
 * nothing to retune when a signal is added or its score distribution shifts.
 *
 * k = 60 is the paper's constant; it controls how steeply contribution decays
 * with rank. Smaller k rewards top-of-list agreement more aggressively.
 */
export const RRF_K = 60;

export interface RrfHit<T> {
  item: T;
  score: number;
  /** 1-based rank within each input list; null where the item was absent. */
  ranks: (number | null)[];
}

export function rrfMerge<T extends { id: string }>(lists: T[][], k: number = RRF_K): RrfHit<T>[] {
  const hits = new Map<string, RrfHit<T>>();
  lists.forEach((list, leg) => {
    list.forEach((item, index) => {
      const rank = index + 1;
      let hit = hits.get(item.id);
      if (!hit) {
        hit = { item, score: 0, ranks: lists.map(() => null) };
        hits.set(item.id, hit);
      }
      hit.score += 1 / (k + rank);
      hit.ranks[leg] = rank;
    });
  });
  // Tie-break on the best rank the item achieved in any list: without it,
  // equal scores resolve by insertion order, which depends on leg order.
  const bestRank = (hit: RrfHit<T>) => Math.min(...hit.ranks.filter((r): r is number => r !== null));
  return [...hits.values()].sort((a, b) => b.score - a.score || bestRank(a) - bestRank(b));
}
