import { describe, expect, it } from 'vitest';
import { QueryRewriterService } from './query-rewriter.service';
import { ScriptedProvider } from '../llm/scripted.provider';
import type { LlmProvider } from '../llm/llm.types';

const history = [{ role: 'user', content: 'Tell me about the refund policy' }];

class FailingProvider extends ScriptedProvider {
  constructor() { super([]); }
  override stream(): AsyncIterable<never> {
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('provider is down')) }) };
  }
}

describe('QueryRewriterService', () => {
  it('skips the LLM call entirely on the first turn', async () => {
    let calls = 0;
    const llm: LlmProvider = new ScriptedProvider(() => { calls++; return ['rewritten']; });
    const rewriter = new QueryRewriterService(llm);
    const result = await rewriter.rewrite('standalone question?', [], undefined);
    expect(result).toEqual({ query: 'standalone question?', rewritten: false });
    expect(calls).toBe(0);
  });

  it('rewrites follow-ups using the history', async () => {
    const rewriter = new QueryRewriterService(new ScriptedProvider(() => ['What is the refund window for the second plan?']));
    const result = await rewriter.rewrite('what about the second one?', history, undefined);
    expect(result).toEqual({ query: 'What is the refund window for the second plan?', rewritten: true });
  });

  it('fails open when the provider errors — degraded, never down', async () => {
    const rewriter = new QueryRewriterService(new FailingProvider() as LlmProvider);
    const result = await rewriter.rewrite('what about the second one?', history, undefined);
    expect(result).toEqual({ query: 'what about the second one?', rewritten: false });
  });

  it('rejects degenerate rewrites (empty or wildly longer than the original)', async () => {
    const empty = new QueryRewriterService(new ScriptedProvider(['  ']));
    expect(await empty.rewrite('follow up?', history, undefined)).toEqual({ query: 'follow up?', rewritten: false });

    const verbose = new QueryRewriterService(new ScriptedProvider(['x'.repeat(1000)]));
    expect(await verbose.rewrite('short?', history, undefined)).toEqual({ query: 'short?', rewritten: false });
  });
});
