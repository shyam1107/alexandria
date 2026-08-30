/**
 * The provider interface every LLM call in Alexandria goes through.
 *
 * Deliberately the INTERSECTION of what providers offer, not any one vendor's
 * shape: Gemini has no system role (systemInstruction + strictly alternating
 * user/model turns) — that mapping is the adapter's job, and an interface
 * shaped like Ollama would be lock-in with extra steps.
 */
export type MessageRole = 'system' | 'user' | 'assistant';

export interface Message {
  role: MessageRole;
  content: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

// 'content_filter' exists because a safety stop is not an error and not a
// normal end: Phase 8's faithfulness harness counts it separately, and a
// pre-generation block maps to a deterministic refusal, not a failure frame.
export type LlmFinishReason = 'stop' | 'length' | 'content_filter' | 'error';

/**
 * An event stream, not a token stream. Yielding plain strings would throw
 * away the usage data that arrives on the terminal chunk (Ollama's
 * prompt_eval_count/eval_count, Gemini's usageMetadata) — and Phase 6's
 * per-tenant cost tracking would become a breaking interface change.
 *
 * `done` carries `provider` because a fallback CHAIN may answer: persisting
 * the injected composite's name would make the cost ledger a lie the moment
 * a fallback fires. Cheap now, breaking later — exactly the lesson of the
 * Phase 5 review.
 */
export type LlmEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; usage: TokenUsage; finishReason: LlmFinishReason; model: string; provider: string };

export interface LlmStreamParams {
  messages: Message[];
  /**
   * What this call is FOR, declared by the caller. Providers must not need
   * it — but a test double has to tell an answer call from a rewrite call,
   * and the alternative is sniffing the system prompt, which couples the
   * platform layer to a chat-layer string and breaks silently the day that
   * prompt is edited. The caller already knows (it passes the same concept
   * to the usage ledger), so it says so.
   */
  purpose?: 'answer' | 'rewrite';
  maxTokens?: number;
  temperature?: number;
  /**
   * Cancellation is not optional: when an SSE client disconnects at token 40
   * the upstream call must die with it — on Ollama that's a warm GPU held,
   * on a metered API it's tokens paid for an answer nobody reads.
   */
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly name: string;
  /**
   * Token counting behind a seam: the default is the chars/4 heuristic (we
   * ship no tokenizer for any model); Phase 6 can substitute a
   * provider-accurate implementation without touching call sites. Prompt
   * budgeting must go through this, never ad-hoc string.length math.
   */
  countTokens(text: string): number;
  /**
   * The model's usable prompt window, in the same unit countTokens returns.
   * Lives on the provider because only the provider knows it — Ollama's is
   * whatever num_ctx we send, Gemini's is a property of the model. Callers
   * budget the WHOLE prompt against this: overflow is not an error anywhere,
   * it is silent truncation of the front, where the system prompt lives.
   */
  readonly contextWindow: number;
  stream(params: LlmStreamParams): AsyncIterable<LlmEvent>;
}
