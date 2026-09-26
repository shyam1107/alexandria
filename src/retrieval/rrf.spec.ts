import { describe, expect, it } from 'vitest';
import { rrfMerge, RRF_K } from './rrf';

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

describe('rrfMerge', () => {
  it('scores by summed reciprocal ranks, k=60 from the original paper', () => {
    const [top] = rrfMerge([rows('a', 'b', 'c'), rows('a')]);
    expect(top.item.id).toBe('a');
    expect(top.score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 1));
  });

  it('promotes a chunk both signals liked over a chunk one signal loved', () => {
    // 'both' is 2nd in each list; 'one-signal' is 1st in only one.
    const [first, second] = rrfMerge([rows('one-signal', 'both', 'x'), rows('y', 'both', 'z')]);
    expect(first.item.id).toBe('both');
    expect(first.score).toBeCloseTo(2 / (RRF_K + 2));
    expect(second.item.id).toBe('one-signal');
  });

  it('keeps ranks per leg for the debug view, null where absent', () => {
    const [hit] = rrfMerge([rows('a', 'b'), rows('c', 'a', 'd')]).filter((h) => h.item.id === 'a');
    expect(hit.ranks).toEqual([1, 2]);
    const [c] = rrfMerge([rows('a', 'b'), rows('c', 'a', 'd')]).filter((h) => h.item.id === 'c');
    expect(c.ranks).toEqual([null, 1]);
  });

  it('breaks exact score ties by best rank, not by insertion order', () => {
    const pads = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}` }));
    // 'b' sits at rank 62 in both lists (score 2/(k+62) = 1/61); 'a' sits at
    // rank 1 of the second list only (score 1/61). Exactly tied — and 'b' is
    // encountered first, so only the best-rank tie-break puts 'a' ahead.
    // (The padding rows occupy the top of the merged list, so compare the
    // relative order of 'a' and 'b', not absolute positions.)
    const l1 = [...pads(61, 'l1-'), { id: 'b' }];
    const l2 = [{ id: 'a' }, ...pads(60, 'l2-'), { id: 'b' }];
    const result = rrfMerge([l1, l2]);
    const aIndex = result.findIndex((h) => h.item.id === 'a');
    const bIndex = result.findIndex((h) => h.item.id === 'b');
    expect(result[aIndex].score).toBeCloseTo(result[bIndex].score);
    expect(aIndex).toBeLessThan(bIndex);
  });

  it('survives an empty leg — hybrid means either signal may match nothing', () => {
    // A stopword-only FTS query returns zero rows; retrieval must still work.
    const result = rrfMerge([rows('a', 'b'), []]);
    expect(result.map((h) => h.item.id)).toEqual(['a', 'b']);
    expect(result[0].ranks).toEqual([1, null]);
  });

  it('returns nothing when no signal matched anything', () => {
    expect(rrfMerge([[], []])).toEqual([]);
  });
});

describe('weighted fusion', () => {
  it('lets a down-weighted list contribute without outvoting a confident one', () => {
    // The measured problem: once the keyword leg used OR semantics it
    // returned something for every question, and at equal weight its noise
    // outranked a confident vector match. Weighting keeps its unique finds
    // while stopping it from reordering the top.
    const vector = [{ id: 'right' }, { id: 'ok' }];
    const fts = [{ id: 'noise' }, { id: 'right' }];

    const equal = rrfMerge([vector, fts]);
    const weighted = rrfMerge([vector, fts], RRF_K, [1, 0.07]);

    expect(weighted[0].item.id, 'the vector leg decides the top slot').toBe('right');
    // 'noise' is still present — it is a candidate, just not a winner.
    expect(weighted.map((h) => h.item.id)).toContain('noise');
    // And down-weighting genuinely changed the ordering, or the test proves nothing.
    expect(equal.map((h) => h.item.id)).not.toEqual(weighted.map((h) => h.item.id));
  });

  it('defaults to equal weights when none are given', () => {
    const a = [{ id: 'x' }];
    const b = [{ id: 'y' }];
    const merged = rrfMerge([a, b]);
    expect(merged[0].score).toBeCloseTo(merged[1].score);
  });

  it('a dual-signal find outranks a vector-only find — that is what buys recall at 0.07', () => {
    // The old version of this test used a ONE-element vector list, which let
    // an FTS-only find appear in the merged output by default — rrfMerge
    // returns the full union, so containment always passes. With a realistic
    // 50-element vector list (CANDIDATES_PER_SIGNAL), an FTS-only find at
    // weight 0.07 scores 0.07/61 = 0.001148 while the worst vector candidate
    // scores 1/110 = 0.009091 — the FTS-only find is buried below all 50
    // vector candidates and cannot surface in the top-k.
    //
    // What the weight actually buys is not surfacing keyword-only finds but
    // promoting DUAL-SIGNAL chunks: a chunk found by both legs gets
    // 1/(60+rank_vec) + 0.07/(60+rank_fts), which beats a vector-only chunk
    // at the same vector rank. That is the measured recall mechanism at 0.07:
    // the `both` class goes from 0.938 (vector-only) to 1.000 (hybrid).
    const pads = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}` }));
    const vector = [...pads(49, 'vec-'), { id: 'dual-signal' }];
    const fts = [{ id: 'dual-signal' }, ...pads(49, 'fts-')];

    const merged = rrfMerge([vector, fts], RRF_K, [1, 0.07]);

    // The dual-signal chunk must rank above every vector-only chunk. It
    // appears at vector rank 50 and FTS rank 1; a vector-only chunk at vector
    // rank 49 scores 1/(60+49) = 0.009174. The dual-signal chunk scores
    // 1/(60+50) + 0.07/(60+1) = 0.009091 + 0.001148 = 0.010239 — it wins.
    const dualIndex = merged.findIndex((h) => h.item.id === 'dual-signal');
    const vecOnlyIndex = merged.findIndex((h) => h.item.id === 'vec-48'); // vector rank 49

    expect(dualIndex, 'dual-signal chunk must be in the merged output').toBeGreaterThanOrEqual(0);
    expect(dualIndex, 'dual-signal chunk must outrank the vector-only chunk at a similar vector rank').toBeLessThan(vecOnlyIndex);
  });
});

