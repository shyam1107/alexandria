import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { LlmProviderError, PromptBlockedError } from './llm.errors';
import type { LlmEvent, LlmFinishReason, LlmProvider, LlmStreamParams, Message } from './llm.types';

interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}

interface GeminiPart {
  text: string;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/** Gemini finish reasons that mean "a safety/policy filter stopped this". */
const SAFETY_FINISH_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE']);

function mapFinishReason(raw: string | undefined): LlmFinishReason {
  if (!raw || raw === 'STOP' || raw === 'FINISH_REASON_UNSPECIFIED') return 'stop';
  if (raw === 'MAX_TOKENS') return 'length';
  if (raw === 'SAFETY' || SAFETY_FINISH_REASONS.has(raw)) return 'content_filter';
  // Unknown values are not success: 'error' keeps them visible in the ledger
  // and in Phase 8's faithfulness metrics instead of laundering them into
  // completed answers.
  return 'error';
}

/**
 * Gemini streamGenerateContent over SSE. Gemini's shape is genuinely
 * different from the LlmProvider intersection and this adapter absorbs ALL
 * of it:
 *
 *  - No system role: system messages become the separate `systemInstruction`
 *    field (concatenated if several).
 *  - `contents` must strictly alternate and start with `user`; our
 *    `assistant` is Gemini's `model`; consecutive same-role messages are
 *    merged with a blank line.
 *  - Usage is `usageMetadata`, which may appear on more than the last chunk —
 *    the LAST one seen wins.
 *  - A prompt can be blocked outright (promptFeedback.blockReason) with ZERO
 *    candidates: a stream that ends having emitted nothing. That maps to
 *    PromptBlockedError — never a done-with-empty-answer, which would
 *    persist an empty assistant turn and poison history.
 *
 * The API key goes in the x-goog-api-key HEADER, never the query string —
 * keys in URLs end up in proxy and access logs.
 *
 * Gemini HAS a real countTokens endpoint; it is deliberately unused. Prompt
 * budgeting is per-keystroke arithmetic in the hot path, and a network round
 * trip per budget check is absurd. The chars/4 heuristic stays, behind the
 * interface seam, exactly as documented on LlmProvider.countTokens.
 */
@Injectable()
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  readonly contextWindow: number;

  constructor(config: ConfigService<Env, true>) {
    this.baseUrl = config.get('GEMINI_BASE_URL', { infer: true }).replace(/\/$/, '');
    this.model = config.get('GEMINI_MODEL', { infer: true });
    this.apiKey = config.get('GEMINI_API_KEY', { infer: true });
    this.contextWindow = config.get('GEMINI_NUM_CTX', { infer: true });
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /** Extracts systemInstruction and enforces Gemini's alternating-turns shape. */
  private toGeminiContents(messages: Message[]): { systemInstruction?: { parts: GeminiPart[] }; contents: GeminiContent[] } {
    const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content);
    const turns = messages.filter((m) => m.role !== 'system');
    const contents: GeminiContent[] = [];
    for (const turn of turns) {
      const role: 'user' | 'model' = turn.role === 'assistant' ? 'model' : 'user';
      const last = contents[contents.length - 1];
      // Gemini rejects consecutive same-role turns; merge, don't reorder —
      // history order is meaning.
      if (last && last.role === role) last.parts[0].text += `\n\n${turn.content}`;
      else contents.push({ role, parts: [{ text: turn.content }] });
    }
    if (contents.length === 0 || contents[0].role !== 'user') {
      throw new LlmProviderError('Gemini requires the first non-system message to be a user turn', {
        provider: this.name,
        model: this.model,
        retryable: false,
      });
    }
    const systemInstruction = systemParts.length > 0 ? { parts: [{ text: systemParts.join('\n\n') }] } : undefined;
    return { systemInstruction, contents };
  }

  async *stream(params: LlmStreamParams): AsyncIterable<LlmEvent> {
    if (!this.apiKey) {
      throw new LlmProviderError('GEMINI_API_KEY is not set', { provider: this.name, model: this.model, retryable: false });
    }
    const { systemInstruction, contents } = this.toGeminiContents(params.messages);
    const generationConfig: Record<string, number> = {};
    if (params.maxTokens !== undefined) generationConfig.maxOutputTokens = params.maxTokens;
    if (params.temperature !== undefined) generationConfig.temperature = params.temperature;

    const response = await fetch(`${this.baseUrl}/v1beta/models/${this.model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({ ...(systemInstruction ? { systemInstruction } : {}), contents, generationConfig }),
      signal: params.signal ?? null,
    });
    if (!response.ok || !response.body) {
      // Drain the body: under undici an unread error response leaks the
      // connection — and the provider's own error text is the difference
      // between "model not found" and "something 500'd".
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new LlmProviderError(`Gemini returned HTTP ${response.status}: ${detail}`, {
        provider: this.name,
        model: this.model,
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      });
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let sawCandidate = false;
    let blockReason: string | undefined;
    let finishReason: LlmFinishReason | undefined;
    let usage: { promptTokens: number; completionTokens: number } | undefined;

    const handle = function* (chunk: GeminiChunk): Generator<LlmEvent> {
      if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
      for (const candidate of chunk.candidates ?? []) {
        sawCandidate = true;
        for (const part of candidate.content?.parts ?? []) {
          if (part.text) yield { type: 'delta', text: part.text };
        }
        if (candidate.finishReason) finishReason = mapFinishReason(candidate.finishReason);
      }
      if (chunk.usageMetadata) {
        usage = {
          promptTokens: chunk.usageMetadata.promptTokenCount ?? 0,
          completionTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
        };
      }
    };

    const processLine = function* (line: string): Generator<LlmEvent> {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      yield* handle(JSON.parse(payload) as GeminiChunk);
    };

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        yield* processLine(line);
      }
    }
    // Flush the decoder and parse any residual buffer: a final SSE line with
    // no trailing newline is still data (the Ollama NDJSON lesson, applied).
    buffer += decoder.decode();
    if (buffer.trim()) yield* processLine(buffer.trim());

    if (!sawCandidate) {
      if (blockReason) throw new PromptBlockedError(blockReason, this.name, this.model);
      throw new LlmProviderError('Gemini stream ended without any candidates', {
        provider: this.name,
        model: this.model,
        retryable: true,
      });
    }
    // A stream that produced candidates but no finishReason was truncated —
    // treating it as 'stop' would persist a partial answer as if complete
    // (the same invariant the Ollama adapter's terminal-frame check keeps).
    if (finishReason === undefined) {
      throw new LlmProviderError('Gemini stream ended without a finishReason', {
        provider: this.name,
        model: this.model,
        retryable: true,
      });
    }
    yield {
      type: 'done',
      usage: usage ?? { promptTokens: 0, completionTokens: 0 },
      finishReason,
      model: this.model,
      provider: this.name,
    };
  }
}
