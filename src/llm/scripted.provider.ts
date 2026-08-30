import type { LlmEvent, LlmProvider, LlmStreamParams, Message } from './llm.types';

/**
 * The default LLM_CHAIN=scripted script. It cannot be a fixed array: the
 * same provider serves the query rewriter, which would then search for
 * "This is a scripted answer [1].". It branches on the caller's declared
 * `purpose` rather than on the system prompt's text — sniffing that string
 * would make this module import a chat-layer constant, pointing the
 * dependency the wrong way for a platform layer whose whole premise is not
 * knowing its consumers, and it would break silently the day the prompt is
 * reworded.
 */
export function defaultScriptedScript(_messages: Message[], purpose?: LlmStreamParams['purpose']): string[] {
  if (purpose === 'rewrite') return ['scripted rewritten search query'];
  return ['This ', 'is ', 'a ', 'scripted ', 'answer ', '[1].'];
}

/**
 * A deterministic provider for tests and offline smoke runs — the same trick
 * the one-hot vectors played for retrieval in Phase 4. It lets the chat
 * pipeline's SSE framing, citation validation, and persistence be tested
 * with no model running anywhere.
 *
 * The script can inspect the messages it receives, which is what makes the
 * query rewriter testable: the rewrite call and the answer call see
 * different prompts and can answer differently.
 */
export class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly contextWindow: number;

  constructor(
    private readonly script: string[] | ((messages: Message[], purpose?: LlmStreamParams['purpose']) => string[]),
    contextWindow = 8192,
  ) {
    this.contextWindow = contextWindow;
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async *stream(params: LlmStreamParams): AsyncIterable<LlmEvent> {
    const chunks = typeof this.script === 'function' ? this.script(params.messages, params.purpose) : this.script;
    let output = '';
    for (const text of chunks) {
      // A disconnected client stops the stream where it stands — no done
      // event, which is exactly the partial-persistence path.
      if (params.signal?.aborted) return;
      output += text;
      yield { type: 'delta', text };
    }
    yield {
      type: 'done',
      usage: {
        promptTokens: params.messages.reduce((sum, m) => sum + this.countTokens(m.content), 0),
        completionTokens: this.countTokens(output),
      },
      finishReason: 'stop',
      model: 'scripted',
      provider: this.name,
    };
  }
}
