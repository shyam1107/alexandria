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
      start = Math.max(end - this.overlap, start + 1);
    }
    return chunks;
  }
}