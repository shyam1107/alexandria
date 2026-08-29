import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { ChunkerService } from './chunker.service';

function chunker(size: number, overlap: number) {
  const settings = { CHUNK_SIZE: size, CHUNK_OVERLAP: overlap } as Partial<Env>;
  return new ChunkerService({ get: (key: keyof Env) => settings[key] } as unknown as ConfigService<Env, true>);
}

const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i}`).join(' ');

describe('ChunkerService', () => {
  it('refuses a configuration where chunks cannot advance', () => {
    // overlap >= size would rewind further than each step moves forward.
    expect(() => chunker(100, 100)).toThrow(/CHUNK_OVERLAP/);
    expect(() => chunker(100, 200)).toThrow(/CHUNK_OVERLAP/);
  });

  it('returns nothing for input with no text', () => {
    expect(chunker(100, 20).split('')).toEqual([]);
    expect(chunker(100, 20).split('   \n\t  ')).toEqual([]);
  });

  it('keeps a short document in a single chunk', () => {
    expect(chunker(100, 20).split('a short document')).toEqual([
      { content: 'a short document', charStart: 0, charEnd: 16 },
    ]);
  });

  it('never emits a chunk longer than the configured size', () => {
    const chunks = chunker(200, 40).split(words(400));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(200);
  });

  it('breaks on whitespace rather than mid-word', () => {
    // Retrieval quality depends on this: a chunk ending in "compli" embeds
    // differently from one ending in "compliance".
    const source = words(400);
    for (const chunk of chunker(200, 40).split(source)) {
      expect(chunk.content).toMatch(/^word\d+/);
      expect(chunk.content).toMatch(/word\d+$/);
    }
  });

  it('overlaps consecutive chunks so context is not severed at the seam', () => {
    const [first, second] = chunker(200, 60).split(words(400));
    // The second chunk must re-open inside territory the first already covered.
    const reopensAt = second.content.split(' ')[0];
    expect(first.content).toContain(reopensAt);
    expect(first.content.endsWith(second.content)).toBe(false);
  });

  it('preserves every word across the chunk boundaries', () => {
    const source = words(300);
    const rejoined = chunker(200, 40).split(source).map((c) => c.content).join(' ');
    for (const word of source.split(' ')) expect(rejoined).toContain(word);
  });

  it('terminates on input with no whitespace to break on', () => {
    // The boundary search finds nothing here; without the 70% floor the loop
    // would fail to advance. A hang in a worker is worse than a bad split.
    const chunks = chunker(100, 20).split('x'.repeat(1000));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.content).join('')).toContain('x');
  });

  it('normalises line endings and runs of horizontal whitespace', () => {
    expect(chunker(100, 20).split('one\r\ntwo    three\t\tfour')).toEqual([
      // 'one' (0..3), '\r\n' collapses to one '\n' (3..5), 'two' (5..8),
      // '    ' collapses to one ' ' (8..12), 'three' (12..17),
      // '\t\t' collapses to one ' ' (17..19), 'four' (19..23).
      { content: 'one\ntwo three four', charStart: 0, charEnd: 23 },
    ]);
  });

  it('maps chunk offsets back into the ORIGINAL text through normalization', () => {
    // Citations slice the source with these offsets; if normalization shifted
    // positions (collapsed runs, CRLF pairs, a leading trim), the highlight
    // lands on the wrong words and the citation lies about its source.
    const source = '\n\n  alpha   beta\r\ngamma \t delta  ';
    for (const chunk of chunker(24, 8).split(source)) {
      expect(source.slice(chunk.charStart, chunk.charEnd).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ')).toBe(chunk.content);
      expect(chunk.content).not.toMatch(/^\s|\s$/);
    }
  });

  it('keeps offsets advancing and non-empty across the whole document', () => {
    // Overlap is the point, so chunk N+1 legitimately starts BEFORE chunk N
    // ends. The real invariants: starts strictly advance (loop termination)
    // and every chunk spans at least one character.
    const chunks = chunker(120, 30).split(words(300));
    let previousStart = -1;
    for (const chunk of chunks) {
      expect(chunk.charStart).toBeGreaterThan(previousStart);
      expect(chunk.charEnd).toBeGreaterThan(chunk.charStart);
      previousStart = chunk.charStart;
    }
  });
});
