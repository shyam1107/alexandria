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
