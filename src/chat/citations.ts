/**
 * Citation extraction and validation.
 *
 * Validation is post-hoc BY NECESSITY, not laziness: the answer is streamed
 * token by token, so by the time `[7]` is parsed it has already been sent to
 * the client. Stripping would require buffering the whole answer, which
 * defeats streaming. So: validate after the stream closes against the context
 * size we already know, report unresolved markers in the terminal frame, and
 * persist the count — Phase 8's faithfulness baseline starts collecting here.
 */
export function extractCitations(answer: string, contextSize: number): { resolved: number[]; unresolved: number[] } {
  const referenced = new Set<number>();
  for (const match of answer.matchAll(/\[(\d+)\]/g)) referenced.add(Number(match[1]));
  const resolved: number[] = [];
  const unresolved: number[] = [];
  for (const n of referenced) {
    if (n >= 1 && n <= contextSize) resolved.push(n);
    else unresolved.push(n);
  }
  resolved.sort((a, b) => a - b);
  unresolved.sort((a, b) => a - b);
  return { resolved, unresolved };
}

/**
 * Removes citation markers from text that is being replayed as conversation
 * HISTORY rather than served as an answer.
 *
 * A stored assistant turn says "...within 30 days [1]." — but `[1]` referred
 * to a source list built for THAT turn's retrieval. The next turn retrieves
 * different chunks and numbers them from 1 again, so feeding the old markers
 * back in tells the model that a number it is about to reuse already means
 * something else. It invites the model to cite [1] for the wrong reason, and
 * costs tokens to do it.
 *
 * Stripped on READ only: the stored row keeps its markers, because the row is
 * the record of what was actually served and `citations` resolves those
 * numbers. Deliberately conservative — only `[n]` with digits, so prose like
 * "[sic]" or code samples survive untouched.
 */
export function stripCitationMarkers(text: string): string {
  return text.replace(/\s?\[\d+\]/g, '').replace(/[ \t]{2,}/g, ' ');
}
