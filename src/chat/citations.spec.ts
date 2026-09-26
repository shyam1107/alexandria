import { describe, expect, it } from 'vitest';
import { extractCitations, stripCitationMarkers } from './citations';

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

describe('stripCitationMarkers', () => {
  it('removes markers that indexed a previous turn\'s source list', () => {
    expect(stripCitationMarkers('Refunds take 30 days [1]. See also [2].')).toBe('Refunds take 30 days. See also.');
  });

  it('leaves non-numeric brackets alone — prose and code are not citations', () => {
    expect(stripCitationMarkers('Use arr[i] and note [sic] the caveat.')).toBe('Use arr[i] and note [sic] the caveat.');
  });

  it('is a no-op on text that never carried markers', () => {
    expect(stripCitationMarkers('No citations here at all.')).toBe('No citations here at all.');
  });
});

