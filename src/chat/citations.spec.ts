import { describe, expect, it } from 'vitest';
import { extractCitations } from './citations';

describe('extractCitations', () => {
  it('resolves markers that exist in the context', () => {
    expect(extractCitations('Refunds take 30 days [1] and shipping 5 [2][1].', 3)).toEqual({
      resolved: [1, 2],
      unresolved: [],
    });
  });

  it('flags markers beyond the context as unresolved — the caught hallucination', () => {
    // Context had 6 items and the answer says [7]: a hallucinated citation,
    // caught for the price of a regex.
    expect(extractCitations('As documented [7], and truly [2].', 6)).toEqual({
      resolved: [2],
      unresolved: [7],
    });
  });

  it('treats [0] as unresolved — citation numbering is 1-based', () => {
    expect(extractCitations('See [0].', 3)).toEqual({ resolved: [], unresolved: [0] });
  });

  it('returns empty lists for an answer with no citations', () => {
    expect(extractCitations('I do not know based on the available documents.', 5)).toEqual({ resolved: [], unresolved: [] });
  });
});
