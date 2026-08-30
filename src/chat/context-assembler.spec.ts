import { describe, expect, it } from 'vitest';
import { assembleContext, trimHistory } from './context-assembler';
import type { SearchHit } from '../retrieval/retrieval.service';

const hit = (overrides: Partial<SearchHit>): SearchHit => ({
  chunkId: 'chunk',
  documentId: 'doc',
  documentTitle: 'Doc',
  chunkIndex: 0,
  content: 'content',
  charStart: 0,
  charEnd: 7,
  score: 0.01,
  ...overrides,
});

// 4 chars per token — the same heuristic the providers use, stated
// explicitly so the budgets below are readable.
const countTokens = (text: string) => Math.ceil(text.length / 4);

describe('assembleContext', () => {
  it('numbers items from 1 and renders them in citation order', () => {
    const { sources, promptText } = assembleContext(
      [hit({ chunkId: 'a', documentTitle: 'Alpha', content: 'alpha text' }), hit({ chunkId: 'b', documentId: 'doc-b', documentTitle: 'Beta', content: 'beta text' })],
      1000,
      countTokens,
    );
    expect(sources.map((s) => s.n)).toEqual([1, 2]);
    expect(promptText).toBe('[1] (Alpha)\nalpha text\n\n[2] (Beta)\nbeta text');
  });

  it('merges adjacent chunks of one document into a single span-accurate item', () => {
    const { sources, promptText } = assembleContext(
      [
        hit({ chunkId: 'c0', chunkIndex: 3, content: 'first half', charStart: 100, charEnd: 110 }),
        hit({ chunkId: 'c1', chunkIndex: 4, content: 'second half', charStart: 104, charEnd: 115 }),
      ],
      1000,
      countTokens,
    );
    // Overlapping chunks repeat ~200 chars verbatim by design; merged, they
    // cost budget once. The citation span covers the whole run.
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ n: 1, chunkId: 'c0', charStart: 100, charEnd: 115 });
    expect(promptText).toContain('first half\nsecond half');
  });

  it('does not merge chunks that are not consecutive within one document', () => {
    const { sources } = assembleContext(
      [hit({ chunkId: 'c0', chunkIndex: 1 }), hit({ chunkId: 'c2', chunkIndex: 5 })],
      1000,
      countTokens,
    );
    expect(sources).toHaveLength(2);
  });

  it('merges runs longer than two chunks', () => {
    // The run must track its LAST index, not its first: comparing 5 against
    // the run's opening index 3 fails, and a three-chunk run silently
    // becomes two items with the overlap text paid for twice.
    const { sources, promptText } = assembleContext(
      [
        hit({ chunkId: 'c3', chunkIndex: 3, content: 'one', charStart: 0, charEnd: 10 }),
        hit({ chunkId: 'c4', chunkIndex: 4, content: 'two', charStart: 8, charEnd: 20 }),
        hit({ chunkId: 'c5', chunkIndex: 5, content: 'three', charStart: 18, charEnd: 30 }),
      ],
      1000,
      countTokens,
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ chunkId: 'c3', charStart: 0, charEnd: 30 });
    expect(promptText).toContain('one\ntwo\nthree');
  });

  it('merges neighbours that fusion ranked apart', () => {
    // Hits arrive in RRF score order, which interleaves documents. Comparing
    // each hit only to its predecessor in THAT order finds no neighbours:
    // A#5 and A#6 are contiguous text with B#2 ranked between them.
    const { sources } = assembleContext(
      [
        hit({ chunkId: 'a5', documentId: 'doc-a', chunkIndex: 5, content: 'alpha five' }),
        hit({ chunkId: 'b2', documentId: 'doc-b', chunkIndex: 2, content: 'beta two' }),
        hit({ chunkId: 'a6', documentId: 'doc-a', chunkIndex: 6, content: 'alpha six' }),
      ],
      1000,
      countTokens,
    );
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ n: 1, chunkId: 'a5' });
    // Regrouping must not cost fusion order: doc-a led the ranking, so it
    // still leads the context.
    expect(sources[1]).toMatchObject({ n: 2, chunkId: 'b2' });
  });

  it('charges each item for its rendered marker and title, not just its text', () => {
    // The model pays for '[1] (Title)\n' too; counting only the body lets the
    // prompt drift over the window a few tokens at a time.
    const { tokens } = assembleContext([hit({ documentTitle: 'Title', content: 'body' })], 1000, countTokens);
    expect(tokens).toBe(countTokens('[1] (Title)\nbody'));
  });

  it('drops whole items that exceed the budget instead of truncating mid-item', () => {
    const big = hit({ chunkId: 'big', content: 'x'.repeat(400) }); // 100 tokens
    const small = hit({ chunkId: 'small', documentId: 'doc-b', chunkIndex: 0, content: 'tiny' }); // 1 token
    const { sources, promptText } = assembleContext([big, small], 50, countTokens);
    expect(sources.map((s) => s.chunkId)).toEqual(['small']);
    expect(promptText).not.toContain('xxxx');
  });
});

describe('trimHistory', () => {
  const turn = (content: string) => ({ role: 'user' as const, content });

  it('keeps the newest turns and drops the oldest first', () => {
    // 10 messages is not a size bound — CHAT_HISTORY_MESSAGES admits ten
    // 4000-character questions, ~10k tokens, which alone overruns an 8k
    // window. Overflow is never reported: the model server truncates the
    // FRONT, taking the system prompt with it.
    const kept = trimHistory([turn('a'.repeat(400)), turn('b'.repeat(400)), turn('c'.repeat(40))], 110, countTokens);
    expect(kept.map((t) => t.content[0])).toEqual(['b', 'c']);
  });

  it('keeps turns whole — half a question is worse context than none', () => {
    expect(trimHistory([turn('x'.repeat(4000))], 100, countTokens)).toEqual([]);
  });

  it('passes short history through untouched', () => {
    const turns = [turn('hello'), turn('there')];
    expect(trimHistory(turns, 1000, countTokens)).toEqual(turns);
  });
});
