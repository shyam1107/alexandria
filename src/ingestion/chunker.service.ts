import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';

@Injectable()
export class ChunkerService {
  private readonly size: number;
  private readonly overlap: number;

  constructor(config: ConfigService<Env, true>) {
    this.size = config.get('CHUNK_SIZE', { infer: true });
    this.overlap = config.get('CHUNK_OVERLAP', { infer: true });
    if (this.overlap >= this.size) throw new Error('CHUNK_OVERLAP must be smaller than CHUNK_SIZE');
  }

  split(text: string): string[] {
    const normalized = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
    const chunks: string[] = [];
    let start = 0;
    while (start < normalized.length) {
      let end = Math.min(start + this.size, normalized.length);
      if (end < normalized.length) {
        const boundary = normalized.lastIndexOf('\n', end);
        const space = normalized.lastIndexOf(' ', end);
        end = Math.max(boundary, space, start + Math.floor(this.size * 0.7));
      }
      const chunk = normalized.slice(start, end).trim();
      if (chunk) chunks.push(chunk);
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
}