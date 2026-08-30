import { describe, expect, it } from 'vitest';
import { QueryRewriterService } from './query-rewriter.service';
import { ScriptedProvider } from '../llm/scripted.provider';
import type { LlmProvider } from '../llm/llm.types';
import type { UsageEntry, UsageLedger } from '../llm/usage-ledger';

const history = [{ role: 'user', content: 'Tell me about the refund policy' }];
const WORKSPACE = '11111111-1111-1111-1111-111111111111';

class FailingProvider extends ScriptedProvider {
  constructor() { super([]); }
  override stream(): AsyncIterable<never> {
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('provider is down')) }) };
  }
}

/** A ledger double that records instead of writing — the SQL side is covered by the usage-ledger integration spec. */
function recordingLedger() {
  const entries: UsageEntry[] = [];
  const ledger = { record: async (_workspaceId: string, entry: UsageEntry) => { entries.push(entry); } } as unknown as UsageLedger;
  return { ledger, entries };
}

describe('QueryRewriterService', () => {
  it('skips the LLM call entirely on the first turn', async () => {
    let calls = 0;
    const llm: LlmProvider = new ScriptedProvider(() => { calls++; return ['rewritten']; });
    const { ledger, entries } = recordingLedger();
    const rewriter = new QueryRewriterService(llm, ledger);
    const result = await rewriter.rewrite('standalone question?', [], WORKSPACE, undefined);
    expect(result).toEqual({ query: 'standalone question?', rewritten: false });
    expect(calls).toBe(0);
    // No call, no spend, no ledger row.
    expect(entries).toHaveLength(0);
  });

  it('rewrites follow-ups using the history — and meters the call', async () => {
    const { ledger, entries } = recordingLedger();
    const rewriter = new QueryRewriterService(new ScriptedProvider(() => ['What is the refund window for the second plan?']), ledger);
    const result = await rewriter.rewrite('what about the second one?', history, WORKSPACE, undefined);
    expect(result).toEqual({ query: 'What is the refund window for the second plan?', rewritten: true });
    // The rewriter's tokens were thrown away before Phase 6; now the row
    // carries the usage the done event reported.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ operation: 'query_rewrite', success: true, provider: 'scripted', model: 'scripted' });
    expect(entries[0].completionTokens).toBeGreaterThan(0);
  });

  it('fails open when the provider errors — degraded, never down, but recorded', async () => {
    const { ledger, entries } = recordingLedger();
    const rewriter = new QueryRewriterService(new FailingProvider() as LlmProvider, ledger);
    const result = await rewriter.rewrite('what about the second one?', history, WORKSPACE, undefined);
    expect(result).toEqual({ query: 'what about the second one?', rewritten: false });
    // Fail-open does not mean fail-silent for the ledger.
    expect(entries).toEqual([expect.objectContaining({ operation: 'query_rewrite', success: false, errorKind: 'provider_error' })]);
  });

  it('rejects degenerate rewrites (empty or wildly longer than the original)', async () => {
    const empty = new QueryRewriterService(new ScriptedProvider(['  ']), recordingLedger().ledger);
    expect(await empty.rewrite('follow up?', history, WORKSPACE, undefined)).toEqual({ query: 'follow up?', rewritten: false });

    const verbose = new QueryRewriterService(new ScriptedProvider(['x'.repeat(1000)]), recordingLedger().ledger);
    expect(await verbose.rewrite('short?', history, WORKSPACE, undefined)).toEqual({ query: 'short?', rewritten: false });
  });
});
