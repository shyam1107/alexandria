import { describe, expect, it } from 'vitest';
import { aggregate, hitRateAtK, ndcgAtK, precisionAtK, recallAtK, reciprocalRank, reciprocalRankAtK } from './metrics';

/**
 * Worked examples with the arithmetic spelled out. A metrics module that is
 * only exercised end-to-end tells you a number came out, not that it is the
 * right number — and every downstream conclusion in Phase 8 ("hybrid beats
 * vector-only", "re-ranking is worth the latency") is that number.
 */
describe('recallAtK', () => {
  it('is the fraction of relevant items inside the cut', () => {
    // 2 of the 4 relevant ids are in the top 3.
    expect(recallAtK(['a', 'x', 'b', 'c'], ['a', 'b', 'c', 'd'], 3)).toBeCloseTo(0.5);
  });

  it('ignores relevant items found below the cut — that is the point of @k', () => {
    expect(recallAtK(['x', 'y', 'z', 'a'], ['a'], 3)).toBe(0);
    expect(recallAtK(['x', 'y', 'z', 'a'], ['a'], 4)).toBe(1);
  });

  it('returns null when nothing is relevant, rather than a misleading 0 or 1', () => {
    // A should-refuse case is not a ranking failure; averaging 0 into the
    // corpus score would make correct refusals look like broken retrieval.
    expect(recallAtK(['a'], [], 5)).toBeNull();
  });
});

describe('precisionAtK', () => {
  it('divides by k, not by the number retrieved', () => {
    // Only 1 relevant in the top 4 => 0.25, even though 2 results came back.
    expect(precisionAtK(['a', 'x'], ['a'], 4)).toBeCloseTo(0.25);
  });

  it('is 0 when nothing was retrieved', () => {
    expect(precisionAtK([], ['a'], 5)).toBe(0);
  });
});

describe('reciprocalRank', () => {
  it('is 1 over the position of the FIRST relevant hit', () => {
    expect(reciprocalRank(['a', 'b'], ['a'])).toBe(1);
    expect(reciprocalRank(['x', 'a'], ['a'])).toBe(0.5);
    expect(reciprocalRank(['x', 'y', 'a'], ['a'])).toBeCloseTo(1 / 3);
  });

  it('is 0 when nothing relevant was retrieved at all', () => {
    expect(reciprocalRank(['x', 'y'], ['a'])).toBe(0);
  });

  it('does not reward finding the second relevant item earlier', () => {
    // Both rank the first relevant hit at position 2; the tail is irrelevant.
    expect(reciprocalRank(['x', 'a', 'b'], ['a', 'b'])).toBe(0.5);
    expect(reciprocalRank(['x', 'b', 'z'], ['a', 'b'])).toBe(0.5);
  });
});

describe('reciprocalRankAtK', () => {
  it('matches reciprocalRank when the hit is inside the cut', () => {
    expect(reciprocalRankAtK(['a', 'b'], ['a'], 5)).toBe(1);
    expect(reciprocalRankAtK(['x', 'a'], ['a'], 5)).toBe(0.5);
  });

  it('returns 0 when the first relevant hit is beyond k — the whole point of @k', () => {
    // Position 6 (0-based 5) with k=5: inside the full list but outside the cut.
    // The unbounded form would score 1/6; the k-bounded form must score 0,
    // because the report column says @5 and a hit at position 6 is not in the
    // top 5. This is the regression test for item [11]: before the fix,
    // aggregate's MRR used the unbounded form and silently credited this.
    expect(reciprocalRankAtK(['x', 'y', 'z', 'w', 'v', 'a'], ['a'], 5)).toBe(0);
    expect(reciprocalRankAtK(['x', 'y', 'z', 'w', 'v', 'a'], ['a'], 6)).toBeCloseTo(1 / 6);
  });

  it('is 0 when nothing relevant was retrieved at all', () => {
    expect(reciprocalRankAtK(['x', 'y'], ['a'], 5)).toBe(0);
  });
});

describe('ndcgAtK', () => {
  it('is 1.0 for a perfect ranking', () => {
    expect(ndcgAtK(['a', 'b', 'x'], ['a', 'b'], 3)).toBeCloseTo(1);
  });

  it('is rank-sensitive where recall is not — the reason re-ranking is measurable', () => {
    const early = ndcgAtK(['a', 'x', 'y'], ['a'], 3)!;
    const late = ndcgAtK(['x', 'y', 'a'], ['a'], 3)!;
    expect(early).toBeGreaterThan(late);
    // Both find the answer inside the cut, so recall cannot tell them apart.
    expect(recallAtK(['a', 'x', 'y'], ['a'], 3)).toBe(recallAtK(['x', 'y', 'a'], ['a'], 3));
  });

  it('matches the arithmetic by hand', () => {
    // relevant at 0-based ranks 0 and 2:
    //   DCG  = 1/log2(2) + 1/log2(4)   = 1 + 0.5     = 1.5
    //   IDCG = 1/log2(2) + 1/log2(3)   = 1 + 0.6309  = 1.6309
    const expected = (1 + 0.5) / (1 + 1 / Math.log2(3));
    expect(ndcgAtK(['a', 'x', 'b'], ['a', 'b'], 3)).toBeCloseTo(expected, 6);
  });

  it('normalises against min(relevant, k), so a full cut can still score 1.0', () => {
    // 3 relevant items but only 2 slots: a perfect top-2 IS perfect. Dividing
    // by an unreachable ideal would cap it below 1 and silently punish nothing.
    expect(ndcgAtK(['a', 'b'], ['a', 'b', 'c'], 2)).toBeCloseTo(1);
  });
});

describe('hitRateAtK', () => {
  it('is binary — did anything relevant land in the cut', () => {
    expect(hitRateAtK(['x', 'a'], ['a'], 2)).toBe(1);
    expect(hitRateAtK(['x', 'a'], ['a'], 1)).toBe(0);
  });
});

describe('aggregate', () => {
  it('macro-averages so one heavily-labelled question cannot dominate', () => {
    const scores = aggregate(
      [
        { retrieved: ['a'], relevant: ['a'] }, // perfect, 1 label
        { retrieved: ['x', 'y'], relevant: ['p', 'q', 'r', 's'] }, // total miss, 4 labels
      ],
      5,
    );
    expect(scores.cases).toBe(2);
    expect(scores.recallAtK, 'macro: (1 + 0) / 2 — not weighted by label count').toBeCloseTo(0.5);
    expect(scores.mrr).toBeCloseTo(0.5);
  });

  it('excludes should-refuse cases from ranking averages', () => {
    const scores = aggregate(
      [
        { retrieved: ['a'], relevant: ['a'] },
        { retrieved: [], relevant: [] }, // a refusal case
      ],
      5,
    );
    expect(scores.cases, 'only the ranking cases are counted').toBe(1);
    expect(scores.recallAtK).toBe(1);
  });

  it('computes MRR at k, not over the full list — a hit beyond the cut scores 0', () => {
    // The first relevant hit is at position 6 (0-based 5). With k=5 the
    // k-bounded MRR must be 0, not 1/6. Before item [11] was fixed, aggregate
    // used the unbounded reciprocalRank and this would have scored 1/6.
    const scores = aggregate(
      [{ retrieved: ['x', 'y', 'z', 'w', 'v', 'a'], relevant: ['a'] }],
      5,
    );
    expect(scores.mrr).toBe(0);
    // Same case with k=6 includes the hit, so MRR is 1/6.
    const scores6 = aggregate(
      [{ retrieved: ['x', 'y', 'z', 'w', 'v', 'a'], relevant: ['a'] }],
      6,
    );
    expect(scores6.mrr).toBeCloseTo(1 / 6);
  });
});
