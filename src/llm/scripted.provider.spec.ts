import { describe, expect, it } from 'vitest';
import { ScriptedProvider, defaultScriptedScript } from './scripted.provider';
import type { LlmEvent } from './llm.types';

/**
 * The default LLM_CHAIN=scripted script. Small surface, but it is what CI
 * and GPU-less laptops run the whole chat pipeline on, and it has already
 * been wrong once: a fixed answer array was handed to the query rewriter
 * too, which then searched the corpus for "This is a scripted answer [1].".
 */
describe('defaultScriptedScript', () => {
  it('answers a rewrite call with a query, not with the answer script', () => {
    expect(defaultScriptedScript([], 'rewrite').join('')).toBe('scripted rewritten search query');
  });

  it('answers an answer call with a citation-bearing answer', () => {
    expect(defaultScriptedScript([], 'answer').join('')).toBe('This is a scripted answer [1].');
  });

  it('defaults to the answer script when no purpose is declared', () => {
    // The safe default: an untagged call is far more likely to be a plain
    // generation than a rewrite, and the rewriter tags itself.
    expect(defaultScriptedScript([]).join('')).toBe('This is a scripted answer [1].');
  });

  it('branches on the declared purpose, never on the prompt text', async () => {
    // The regression guard for the dependency direction: this module must
    // not need to recognise a chat-layer system prompt. A rewrite call whose
    // messages say nothing identifiable still gets a query back.
    const provider = new ScriptedProvider(defaultScriptedScript);
    const events: LlmEvent[] = [];
    for await (const event of provider.stream({ messages: [{ role: 'user', content: 'anything at all' }], purpose: 'rewrite' })) {
      events.push(event);
    }
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe('scripted rewritten search query');
  });
});
