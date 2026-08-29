import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';

export interface Chunk {
  content: string;
  /**
   * Offsets into the ORIGINAL parser output, before whitespace normalization
   * (charEnd exclusive). A citation highlights `source.slice(charStart, charEnd)`.
   * Normalization collapses whitespace runs and CRLF pairs, so these offsets
   * cannot be reconstructed from the stored chunk content — they must be
   * captured while splitting. Retrofitting them later means re-ingesting
   * every document, which is why they exist from Phase 4.
   */
  charStart: number;
  charEnd: number;
}

/**
 * One entry per character of the normalized text, pointing at the span of the
 * original text that produced it. A collapsed run of spaces maps to the whole
 * run; a CRLF pair maps to both characters, so a chunk ending exactly on such
 * a boundary still covers the original bytes.
 */
interface OriginSpan {
  start: number;
  length: number;
}

@Injectable()
export class ChunkerService {
  private readonly size: number;
  private readonly overlap: number;

  constructor(config: ConfigService<Env, true>) {
    this.size = config.get('CHUNK_SIZE', { infer: true });
    this.overlap = config.get('CHUNK_OVERLAP', { infer: true });
    if (this.overlap >= this.size) throw new Error('CHUNK_OVERLAP must be smaller than CHUNK_SIZE');
  }

  split(text: string): Chunk[] {
    const { normalized, origin } = this.normalize(text);
    const chunks: Chunk[] = [];
    let start = 0;
    while (start < normalized.length) {
      let end = Math.min(start + this.size, normalized.length);
      if (end < normalized.length) {
        const boundary = normalized.lastIndexOf('\n', end);
        const space = normalized.lastIndexOf(' ', end);
        end = Math.max(boundary, space, start + Math.floor(this.size * 0.7));
      }
      // The old implementation did slice(start, end).trim(); trimming here
      // instead keeps `end` (which drives the loop) untouched while letting
      // the offsets describe exactly the stored content.
      let s = start;
      let e = end;
      while (s < e && /\s/.test(normalized[s])) s++;
      while (e > s && /\s/.test(normalized[e - 1])) e--;
      if (s < e) {
        chunks.push({
          content: normalized.slice(s, e),
          charStart: origin[s].start,
          charEnd: origin[e - 1].start + origin[e - 1].length,
        });
      }
      if (end >= normalized.length) break;
      // Rewinding by a fixed character count lands mid-word, so every chunk
      // after the first would begin with a fragment ("ord24 word25 ..."). That
      // fragment is embedded as-is and surfaces verbatim in a citation, so
      // snap forward to the next whitespace. Falling back to the raw offset
      // when there is none keeps the loop advancing on unbroken input.
      let next = Math.max(end - this.overlap, start + 1);
      const boundary = /\s/.exec(normalized.slice(next, end));
      if (boundary) next += boundary.index + 1;
      start = next;
    }
    return chunks;
  }

  /**
   * Normalizes line endings and horizontal whitespace runs (the same rules the
   * regex version applied) while recording, for every emitted character, where
   * it came from in the input. Leading/trailing whitespace is dropped by
   * narrowing the window, not by re-slicing, so the map stays aligned.
   */
  private normalize(raw: string): { normalized: string; origin: OriginSpan[] } {
    const chars: string[] = [];
    const spans: OriginSpan[] = [];
    let i = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (c === '\r' && raw[i + 1] === '\n') {
        chars.push('\n');
        spans.push({ start: i, length: 2 });
        i += 2;
      } else if (c === ' ' || c === '\t') {
        let j = i;
        while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t')) j++;
        chars.push(' ');
        spans.push({ start: i, length: j - i });
        i = j;
      } else {
        chars.push(c);
        spans.push({ start: i, length: 1 });
        i++;
      }
    }
    let from = 0;
    let to = chars.length;
    while (from < to && /\s/.test(chars[from])) from++;
    while (to > from && /\s/.test(chars[to - 1])) to--;
    return { normalized: chars.slice(from, to).join(''), origin: spans.slice(from, to) };
  }
}