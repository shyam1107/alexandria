import { Logger } from '@nestjs/common';
import { LlmProviderError, LlmTimeoutError, PromptBlockedError } from './llm.errors';
import type { LlmEvent, LlmProvider, LlmStreamParams } from './llm.types';

export interface ResilientProviderOptions {
  /** The fallback chain, in order. A single-provider chain still gets retries and timeouts. */
  providers: LlmProvider[];
  /** Retries PER chain step, not shared across the chain: [A, B] with 2 retries is A×3 then B×3. */
  maxRetries: number;
  baseDelayMs: number;
  /** A provider saying "wait 60s" is a fallback signal, not a retry invitation. */
  retryAfterCapMs: number;
  firstTokenTimeoutMs: number;
  idleTimeoutMs: number;
  /**
   * Clock seam for tests — the suite injects a no-op and asserts on recorded
   * delays instead of fake-timer gymnastics against the real event loop.
   */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The resilience decorator: retries with backoff, fallback across providers,
 * and stream deadlines, all behind the same LlmProvider interface so every
 * consumer (chat, the rewriter, anything Phase 7 adds) inherits the behaviour
 * without knowing it exists.
 *
 * THE load-bearing invariant: retry and fallback are only legal BEFORE the
 * first delta. Once a delta has been yielded, its bytes are on the client's
 * wire — a retry duplicates text, a fallback splices two models' prose
 * together. So this wrapper pulls the first event from each candidate stream
 * ITSELF, buffering until the first delta; a failure before that point is
 * invisible to the caller, a failure after it is simply rethrown (the honest
 * options remain the error frame and the persisted partial).
 *
 * Two stream deadlines, because one total timeout would be wrong: a
 * first-token deadline (provider unreachable or queueing; a cold local model
 * load legitimately takes 10–20s) and an idle deadline BETWEEN tokens (the
 * stream stalled). A long answer is legitimately slow; silence is not.
 *
 * contextWindow is the MINIMUM across the chain and countTokens the MAXIMUM
 * estimate: ChatService budgets the prompt BEFORE streaming, so if the
 * primary's larger window were reported and the call fell back to a smaller
 * model, the prompt would silently overrun and the server would truncate the
 * FRONT — where the system prompt lives. The values look wrong until you
 * know why; this comment is the why. Consequence, deliberate: a tiny
 * fallback window can squeeze the context budget to nothing, which lands in
 * ChatService's deterministic refusal — degraded to "I don't know", never
 * degraded to wrong answers.
 */
export class ResilientProvider implements LlmProvider {
  readonly name: string;
  readonly contextWindow: number;
  private readonly providers: LlmProvider[];
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly retryAfterCapMs: number;
  private readonly firstTokenTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger = new Logger(ResilientProvider.name);

  constructor(options: ResilientProviderOptions) {
    if (options.providers.length === 0) throw new Error('ResilientProvider requires at least one provider in the chain');
    this.providers = options.providers;
    this.maxRetries = options.maxRetries;
    this.baseDelayMs = options.baseDelayMs;
    this.retryAfterCapMs = options.retryAfterCapMs;
    this.firstTokenTimeoutMs = options.firstTokenTimeoutMs;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.sleep = options.sleep ?? defaultSleep;
    this.name = `chain(${this.providers.map((p) => p.name).join('>')})`;
    this.contextWindow = Math.min(...this.providers.map((p) => p.contextWindow));
  }

  countTokens(text: string): number {
    return Math.max(...this.providers.map((p) => p.countTokens(text)));
  }


  async *stream(params: LlmStreamParams): AsyncIterable<LlmEvent> {
    let lastError: unknown;
    for (const provider of this.providers) {
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        const iterator = this.attemptStream(provider, params)[Symbol.asyncIterator]();
        const buffer: LlmEvent[] = [];
        try {
          // Pull until the first delta. Anything earlier (a bare done, or a
          // stream that ends having emitted nothing) is decided here, while
          // the caller has seen NOTHING and a retry/fallback is still legal.
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              if (buffer.some((e) => e.type === 'done')) break;
              throw new LlmProviderError('Stream ended without emitting any event', {
                provider: provider.name,
                retryable: true,
              });
            }
            buffer.push(next.value);
            if (next.value.type === 'delta') break;
          }
        } catch (error) {
          await iterator.return?.();
          // Two errors stop the ENTIRE chain, not just this step: a caller
          // abort (the client is gone — there is nobody to fall back FOR)
          // and a prompt block (falling back to a provider with different
          // safety tuning is a policy decision, not resilience).
          if (params.signal?.aborted || error instanceof PromptBlockedError) throw error;
          if (!this.isRetryable(error) || attempt === this.maxRetries) {
            lastError = error;
            break;
          }
          const delay = this.delayFor(attempt, error);
          this.logger.warn(`${provider.name} attempt ${attempt + 1} failed pre-first-token (${describe(error)}); retrying in ${delay}ms`);
          await this.sleep(delay);
          continue;
        }
        // Committed: the first delta is leaving this wrapper. From here on,
        // errors propagate untouched — mid-stream retry would corrupt output.
        for (const event of buffer) yield event;
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) return;
            yield next.value;
          }
        } finally {
          await iterator.return?.();
        }
      }
      if (lastError !== undefined && this.providers.indexOf(provider) < this.providers.length - 1) {
        this.logger.warn(`${provider.name} exhausted; falling back to the next provider in the chain`);
      }
    }
    throw lastError;
  }

  /**
   * One attempt: the wrapped provider's stream, with our two deadlines
   * composed alongside the caller's signal. Ours abort with a REASON
   * (LlmTimeoutError), which is what later lets the error path tell "our
   * deadline fired" apart from "the client hung up" — those persist
   * differently and only one of them is retryable.
   */
  private async *attemptStream(provider: LlmProvider, params: LlmStreamParams): AsyncIterable<LlmEvent> {
    const timeouts = new AbortController();
    const signal = params.signal ? AbortSignal.any([params.signal, timeouts.signal]) : timeouts.signal;
    let firstTokenTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    try {
      firstTokenTimer = setTimeout(() => timeouts.abort(new LlmTimeoutError('first_token', provider.name)), this.firstTokenTimeoutMs);
      for await (const event of provider.stream({ ...params, signal })) {
        clearTimeout(firstTokenTimer);
        firstTokenTimer = undefined;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => timeouts.abort(new LlmTimeoutError('idle', provider.name)), this.idleTimeoutMs);
        yield event;
      }
    } finally {
      clearTimeout(firstTokenTimer);
      clearTimeout(idleTimer);
    }
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof LlmTimeoutError) return true;
    if (error instanceof LlmProviderError) return error.retryable;
    // Node's fetch throws TypeError on connection failure (ECONNREFUSED, DNS,
    // TLS) — the network class of transient. Everything else is a bug.
    if (error instanceof TypeError) return true;
    return false;
  }

  private delayFor(attempt: number, error: unknown): number {
    if (error instanceof LlmProviderError && error.retryAfterMs !== undefined) {
      return Math.min(error.retryAfterMs, this.retryAfterCapMs);
    }
    // Full jitter, not ±10%: decorrelating a thundering herd is the point.
    return Math.floor(Math.random() * this.baseDelayMs * 2 ** attempt);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
