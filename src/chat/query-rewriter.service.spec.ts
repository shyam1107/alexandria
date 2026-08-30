import { describe, expect, it } from 'vitest';
import { QueryRewriterService } from './query-rewriter.service';
import { ScriptedProvider } from '../llm/scripted.provider';
import type { LlmProvider } from '../llm/llm.types';
import type { UsageEntry, UsageLedger } from '../llm/usage-ledger';

const history = [{ role: 'user', content: 'Tell me about the refund policy' }];
const WORKSPACE = '11111111-1111-1111-1111-111111111111';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The rewriter reads CHAT_REWRITE_BUDGET_MS from config; tests pin it high
// (except the budget test, which pins it low) — the value is a policy knob,
// the behaviour under it is what the suite asserts.
const configStub = (budgetMs: number) =>
  ({ get: (key: string) => {
    if (key === 'CHAT_REWRITE_BUDGET_MS') return budgetMs;
    throw new Error(`config stub asked for unexpected key ${key}`);
  } }) as never;

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
    const rewriter = new QueryRewriterService(llm, ledger, configStub(5000));
    const result = await rewriter.rewrite('standalone question?', [], WORKSPACE, undefined);
    expect(result).toEqual({ query: 'standalone question?', rewritten: false });
    expect(calls).toBe(0);
    // No call, no spend, no ledger row.
    expect(entries).toHaveLength(0);
  });

  it('rewrites follow-ups using the history — and meters the call', async () => {
    const { ledger, entries } = recordingLedger();
    const rewriter = new QueryRewriterService(new ScriptedProvider(() => ['What is the refund window for the second plan?']), ledger, configStub(5000));
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
    const rewriter = new QueryRewriterService(new FailingProvider() as LlmProvider, ledger, configStub(5000));
    const result = await rewriter.rewrite('what about the second one?', history, WORKSPACE, undefined);
    expect(result).toEqual({ query: 'what about the second one?', rewritten: false });
    // Fail-open does not mean fail-silent for the ledger.
    expect(entries).toEqual([expect.objectContaining({ operation: 'query_rewrite', success: false, errorKind: 'provider_error' })]);
  });

  it('rejects degenerate rewrites (empty or wildly longer than the original)', async () => {
    const empty = new QueryRewriterService(new ScriptedProvider(['  ']), recordingLedger().ledger, configStub(5000));
    expect(await empty.rewrite('follow up?', history, WORKSPACE, undefined)).toEqual({ query: 'follow up?', rewritten: false });

    const verbose = new QueryRewriterService(new ScriptedProvider(['x'.repeat(1000)]), recordingLedger().ledger, configStub(5000));
    expect(await verbose.rewrite('short?', history, WORKSPACE, undefined)).toEqual({ query: 'short?', rewritten: false });
  });

  /**
   * The Phase 7 rewrite budget. The rewrite is an optimization inside the
   * chat pre-frame window: it fails open by design, but a cold model must
   * not eat the window the user is waiting in. The budget aborts with a
   * REASON, which is what keeps the ledger entry honest — an abandoned
   * rewrite is a 'timeout', never a 'client_disconnect' (the client is
   * still there, waiting).
   *
   * Proven to bite: without the budget (constructor budgetMs = huge), this
   * test hangs on the stalling provider instead of returning.
   */
  it('abandons a stalling rewrite at its budget and records a timeout, not a client disconnect', async () => {
    // A provider that accepts the call and never yields a single event.
    const stalling: LlmProvider = {
      name: 'stalling',
      contextWindow: 8192,
      countTokens: (text: string) => Math.ceil(text.length / 4),
      stream: () =>
        ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => undefined) }) }) as AsyncIterable<never>,
    };
    const { ledger, entries } = recordingLedger();
    const rewriter = new QueryRewriterService(stalling, ledger, configStub(20));

    const started = Date.now();
    const result = await rewriter.rewrite('what about the second one?', history, WORKSPACE, undefined);

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toEqual({ query: 'what about the second one?', rewritten: false });
    expect(entries).toEqual([expect.objectContaining({ operation: 'query_rewrite', success: false, errorKind: 'timeout' })]);
  });

  it('still records a client_disconnect when the CLIENT leaves (the budget is not the client)', async () => {
    // The caller aborts mid-rewrite: the ledger must say client_disconnect,
    // not timeout — the distinction the abort-with-reason exists to keep.
    const client = new AbortController();
    const stalling: LlmProvider = {
      name: 'stalling',
      contextWindow: 8192,
      countTokens: (text: string) => Math.ceil(text.length / 4),
      stream: (params: { signal?: AbortSignal }) =>
        ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<never>((_, reject) => {
                params.signal?.addEventListener('abort', () => reject(params.signal!.reason));
              }),
          }),
        }) as AsyncIterable<never>,
    };
    const { ledger, entries } = recordingLedger();
    const rewriter = new QueryRewriterService(stalling, ledger, configStub(10_000));

    const pending = rewriter.rewrite('what about the second one?', history, WORKSPACE, client.signal);
    await delay(30);
    client.abort();
    const result = await pending;

    expect(result).toEqual({ query: 'what about the second one?', rewritten: false });
    expect(entries).toEqual([expect.objectContaining({ operation: 'query_rewrite', success: false, errorKind: 'client_disconnect' })]);
  });
});
