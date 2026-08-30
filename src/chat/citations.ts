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
