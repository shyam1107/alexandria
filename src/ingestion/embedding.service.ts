import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';

@Injectable()
export class EmbeddingService {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly dimensions: number;

  constructor(config: ConfigService<Env, true>) {
    this.baseUrl = config.get('EMBEDDING_BASE_URL', { infer: true }).replace(/\/$/, '');
    this.model = config.get('EMBEDDING_MODEL', { infer: true });
    this.dimensions = config.get('EMBEDDING_DIMENSIONS', { infer: true });
  }

  get modelName(): string {
    return this.model;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!response.ok) throw new Error(`Embedding provider returned HTTP ${response.status}`);
    const payload = await response.json() as { embedding?: number[] };
    if (!payload.embedding || payload.embedding.length !== this.dimensions) {
      throw new Error(`Embedding dimension mismatch: expected ${this.dimensions}`);
    }
    return payload.embedding;
  }
}