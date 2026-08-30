/**
 * Typed errors the resilient chain classifies on. The whole retry/fallback
 * design rests on distinguishing four situations that plain Errors cannot
 * express:
 *  - retryable provider failure (429/5xx, connection errors, timeouts)
 *  - non-retryable provider failure (4xx — our bug; retrying burns latency)
 *  - prompt blocked by a safety filter (never retried, never fallen back —
 *    falling back to a provider with different safety tuning is a policy
 *    decision, not a resilience one)
 *  - caller abort (not an error at all from the chain's perspective)
 */

export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly options: {
      provider?: string;
      model?: string;
      status?: number;
      retryable: boolean;
      /** Parsed Retry-After on a 429, clamped by the wrapper, not here. */
      retryAfterMs?: number;
    },
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }

  get provider(): string | undefined {
    return this.options.provider;
  }

  get model(): string | undefined {
    return this.options.model;
  }

  get status(): number | undefined {
    return this.options.status;
  }

  get retryable(): boolean {
    return this.options.retryable;
  }

  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }
}

/**
 * Fired by the resilient wrapper's own deadlines, composed with the caller's
 * signal via AbortSignal.any. This is what makes "our timeout" (retryable
 * pre-first-delta, persisted as an error) distinguishable from "the client
 * left" (never retried, persisted as a partial) — the two used to land in
 * the same catch block and be indistinguishable.
 */
export class LlmTimeoutError extends Error {
  constructor(
    readonly kind: 'first_token' | 'idle',
    readonly provider?: string,
  ) {
    super(kind === 'first_token' ? 'Provider did not produce a first token before the deadline' : 'Provider stream stalled between tokens');
    this.name = 'LlmTimeoutError';
  }
}

/**
 * The provider refused the prompt outright (Gemini promptFeedback.blockReason
 * with zero candidates — a stream that ends having emitted nothing). Mapped
 * by ChatService to a deterministic refusal, NOT the generic failure path:
 * persisting an empty assistant turn would poison conversation history.
 */
export class PromptBlockedError extends Error {
  constructor(
    readonly blockReason: string,
    readonly provider: string,
    readonly model?: string,
  ) {
    super(`Prompt blocked by ${provider}: ${blockReason}`);
    this.name = 'PromptBlockedError';
  }
}
