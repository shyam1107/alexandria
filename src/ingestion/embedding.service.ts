import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { UsageLedger } from '../llm/usage-ledger';

export interface EmbedContext {
  workspaceId: string;
  operation: 'embedding_index' | 'embedding_query';
}

/**
 * Embeddings are under the platform layer for retries, timeouts and cost —
 * but deliberately NOT for cross-provider fallback. EMBEDDING_DIMENSIONS is
 * pinned to 768 and the HNSW index plus every stored vector assume one
 * model's geometry: a different model's 768-dim vector is not wrong-shaped,
 * it is meaningless in the existing space, and every subsequent search
 * quietly degrades. If you are adding a Gemini embeddings path: that is a
 * re-indexing migration of the whole corpus, not a fallback chain entry.
 *
 * Query-embedding failure fails LOUD (HTTP 502 before the first SSE frame):
 * silently degrading hybrid search to FTS-only returns answers through the
 * same grammar with the same citation chips, so "search got subtly worse on
 * Tuesday" would be an incident nobody could reconstruct. Retries absorb
 * transients; a persistent outage is a real outage and presents as one.
 */
@Injectable()
export class EmbeddingService {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly dimensions: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  /** Test seam: retry delays are injected so unit tests don't wait. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    config: ConfigService<Env, true>,
    private readonly ledger: UsageLedger,
  ) {
    this.baseUrl = config.get('EMBEDDING_BASE_URL', { infer: true }).replace(/\/$/, '');
    this.model = config.get('EMBEDDING_MODEL', { infer: true });
    this.dimensions = config.get('EMBEDDING_DIMENSIONS', { infer: true });
    this.timeoutMs = config.get('EMBEDDING_TIMEOUT_MS', { infer: true });
    this.maxRetries = config.get('EMBEDDING_MAX_RETRIES', { infer: true });
  }

  get modelName(): string {
    return this.model;
  }

  async embed(text: string, context: EmbedContext): Promise<number[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const embedding = await this.embedOnce(text);
        // Usage arrives nowhere for Ollama embeddings: prompt_tokens stays
        // null rather than estimated. Estimated tokens are how finance stops
        // trusting a ledger. (Flat-price provider: cost is still its
        // declared 0.)
        await this.ledger.record(context.workspaceId, {
          operation: context.operation,
          provider: 'ollama',
          model: this.model,
          success: true,
        });
        return embedding;
      } catch (error) {
        lastError = error;
        const retryable = isRetryableEmbeddingError(error);
        if (!retryable || attempt === this.maxRetries) break;
        await this.sleep(Math.floor(Math.random() * 500 * 2 ** attempt));
      }
    }
    await this.ledger.record(context.workspaceId, {
      operation: context.operation,
      provider: 'ollama',
      model: this.model,
      success: false,
      errorKind: lastError instanceof Error && lastError.name === 'TimeoutError' ? 'timeout' : 'provider_error',
    });
    throw lastError;
  }

  private async embedOnce(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      // Drain the body: under undici an unread error response leaks the
      // connection, and the provider's text is the only useful diagnostic.
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      const error = new Error(`Embedding provider returned HTTP ${response.status}: ${detail}`);
      (error as { retryable?: boolean }).retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
    const payload = (await response.json()) as { embedding?: number[] };
    if (!payload.embedding || payload.embedding.length !== this.dimensions) {
      throw new Error(`Embedding dimension mismatch: expected ${this.dimensions}`);
    }
    return payload.embedding;
  }
}

function isRetryableEmbeddingError(error: unknown): boolean {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return true;
  if (error instanceof TypeError) return true; // fetch network failure
  return (error as { retryable?: boolean }).retryable === true;
}