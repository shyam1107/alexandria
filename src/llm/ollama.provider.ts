import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { LlmProviderError } from './llm.errors';
import type { LlmEvent, LlmProvider, LlmStreamParams } from './llm.types';

interface OllamaChatChunk {
  model?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Ollama /api/chat — one code path for localhost and ollama.com: the cloud
 * host speaks the same API plus a Bearer key, which is sent only when
 * OLLAMA_API_KEY is set.
 */
@Injectable()
export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  /** Ollama's window is whatever num_ctx we send, so the two are one value. */
  readonly contextWindow: number;

  constructor(config: ConfigService<Env, true>) {
    this.baseUrl = config.get('OLLAMA_BASE_URL', { infer: true }).replace(/\/$/, '');
    this.model = config.get('GENERATION_MODEL', { infer: true });
    this.apiKey = config.get('OLLAMA_API_KEY', { infer: true });
    this.contextWindow = config.get('GENERATION_NUM_CTX', { infer: true });
  }

  countTokens(text: string): number {
    // chars/4 heuristic — the interface's default. Nobody ships a tokenizer
    // for these models; Phase 6 can upgrade this without touching call sites.
    return Math.ceil(text.length / 4);
  }

  async *stream(params: LlmStreamParams): AsyncIterable<LlmEvent> {
    const options: Record<string, number> = {
      // Never let Ollama's 2048-token default stand: it truncates the FRONT
      // of the prompt — the system prompt — silently.
      num_ctx: this.contextWindow,
    };
    if (params.maxTokens !== undefined) options.num_predict = params.maxTokens;
    if (params.temperature !== undefined) options.temperature = params.temperature;

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, messages: params.messages, stream: true, options }),
      signal: params.signal ?? null,
    });
    if (!response.ok || !response.body) {
      // Drain the body: under undici an unread error response leaks the
      // connection — and the provider's own error text is the difference
      // between "model not found" (404, fix the config) and a 500 (retry).
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new LlmProviderError(`Ollama returned HTTP ${response.status}: ${detail}`, {
        provider: this.name,
        model: this.model,
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      });
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const configuredModel = this.model;
    const providerName = this.name;

    function* processLine(line: string): Generator<LlmEvent> {
      const parsed = JSON.parse(line) as OllamaChatChunk;
      if (parsed.message?.content) yield { type: 'delta', text: parsed.message.content };
      if (parsed.done) {
        yield {
          type: 'done',
          usage: {
            promptTokens: parsed.prompt_eval_count ?? 0,
            completionTokens: parsed.eval_count ?? 0,
          },
          finishReason: parsed.done_reason === 'length' ? 'length' : 'stop',
          model: parsed.model ?? configuredModel,
          provider: providerName,
        };
      }
    }

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        for (const event of processLine(line)) {
          yield event;
          if (event.type === 'done') return;
        }
      }
    }
    // Flush the decoder and parse any residual buffer: a final NDJSON line
    // with no trailing newline is still data — and it is usually the `done`
    // line, i.e. the one carrying usage. Dropping it was a data-loss bug
    // wearing a framing bug's clothes.
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const event of processLine(buffer.trim())) {
        yield event;
        if (event.type === 'done') return;
      }
    }
    // A body that ends without a done line is a truncated stream; treating it
    // as a normal end would persist a partial answer as if it were complete.
    // Retryable: truncation is a connection event, not a request bug.
    throw new LlmProviderError('Generation stream ended without a terminal frame', {
      provider: this.name,
      model: this.model,
      retryable: true,
    });
  }
}
