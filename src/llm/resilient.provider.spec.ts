import { describe, expect, it } from 'vitest';
import { ResilientProvider } from './resilient.provider';
import { LlmProviderError, LlmTimeoutError, PromptBlockedError } from './llm.errors';
import { ScriptedProvider } from './scripted.provider';
import type { LlmEvent, LlmProvider, LlmStreamParams } from './llm.types';

/**
 * Retry/fallback semantics, tested against deliberately failing provider
 * doubles — never mocked timers against the real network. The clock is the
 * injected `sleep` seam: delays are recorded, not waited. Timeout tests are
 * the exception: they use real (short) deadlines against providers that hang
 * on purpose, because a timeout you can fake isn't a timeout.
 */

const PARAMS: LlmStreamParams = { messages: [{ role: 'user', content: 'hi' }] };

function options(overrides: Partial<ConstructorParameters<typeof ResilientProvider>[0]> = {}) {
  const delays: number[] = [];
  return {
    delays,
    options: {
      providers: [new ScriptedProvider(['ok'])] as LlmProvider[],
      maxRetries: 2,
      baseDelayMs: 100,
      retryAfterCapMs: 10_000,
      firstTokenTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
      ...overrides,
    },
  };
}

async function collect(provider: LlmProvider, params: LlmStreamParams = PARAMS): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const event of provider.stream(params)) events.push(event);
  return events;
}

/** Fails `failures` times before the first delta, then answers like ScriptedProvider. */
class FlakyProvider extends ScriptedProvider {
  calls = 0;
  constructor(
    private failures: number,
    private error: () => Error = () => new LlmProviderError('HTTP 500: boom', { provider: 'flaky', status: 500, retryable: true }),
  ) {
    super(['recovered']);
  }
  override async *stream(): AsyncIterable<LlmEvent> {
    this.calls++;
    if (this.calls <= this.failures) throw this.error();
    yield* super.stream({ messages: [] });
  }
}

/** Yields one delta and THEN dies: the mid-stream failure that must never be retried. */
class DiesAfterDelta extends ScriptedProvider {
  calls = 0;
  constructor() {
    super([]);
  }
  override async *stream(): AsyncIterable<LlmEvent> {
    this.calls++;
    yield { type: 'delta', text: 'partial ' };
    throw new LlmProviderError('HTTP 500: boom', { provider: 'dier', status: 500, retryable: true });
  }
}

/** Never produces anything: the first-token timeout path. */
class HangsProvider extends ScriptedProvider {
  calls = 0;
  constructor() {
    super([]);
  }
  override stream(params: LlmStreamParams): AsyncIterable<LlmEvent> {
    this.calls++;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<LlmEvent>>((_, reject) => {
            // The wrapper always composes a signal (its own timeout clock),
            // so this listener is what a timeout fires into.
            params.signal!.addEventListener('abort', () => reject(params.signal!.reason));
          }),
      }),
    };
  }
}

describe('ResilientProvider', () => {
  it('retries a retryable pre-first-token failure and succeeds transparently', async () => {
    const flaky = new FlakyProvider(2);
    const { options: opts, delays } = options({ providers: [flaky] });
    const events = await collect(new ResilientProvider(opts));

    expect(flaky.calls).toBe(3);
    expect(delays).toHaveLength(2); // two failures, two backoff waits
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe('recovered');
    // done.provider names the provider that ACTUALLY answered (the
    // ScriptedProvider base reports its own name) — the ledger depends on it.
    expect(events.at(-1)).toMatchObject({ type: 'done', provider: 'scripted' });
  });

  it('never retries a non-retryable 4xx — that is our bug, not a transient', async () => {
    const bad = new FlakyProvider(10, () => new LlmProviderError('HTTP 400: bad request', { provider: 'flaky', status: 400, retryable: false }));
    const { options: opts, delays } = options({ providers: [bad] });
    await expect(collect(new ResilientProvider(opts))).rejects.toThrow(/400/);
    expect(bad.calls).toBe(1);
    expect(delays).toHaveLength(0);
  });

  it('never retries when the CALLER aborted — a client that left is not a failure', async () => {
    const caller = new AbortController();
    const aborted = new FlakyProvider(10, () => {
      caller.abort();
      return new LlmProviderError('HTTP 500: boom', { provider: 'flaky', status: 500, retryable: true });
    });
    // The fallback must not be attempted either: there is nobody to answer.
    class Probe extends ScriptedProvider {
      calls = 0;
      override async *stream(params: LlmStreamParams): AsyncIterable<LlmEvent> {
        this.calls++;
        yield* super.stream(params);
      }
    }
    const fallback = new Probe(['should not be used']);
    const { options: opts } = options({ providers: [aborted, fallback] });
    await expect(collect(new ResilientProvider(opts), { ...PARAMS, signal: caller.signal })).rejects.toThrow(/500/);
    expect(aborted.calls).toBe(1);
    expect(fallback.calls).toBe(0);
  });

  it('never retries after the first delta — the bytes are already on the wire', async () => {
    const dier = new DiesAfterDelta();
    const { options: opts, delays } = options({ providers: [dier] });

    const events: LlmEvent[] = [];
    await expect(
      (async () => {
        for await (const event of new ResilientProvider(opts).stream(PARAMS)) events.push(event);
      })(),
    ).rejects.toThrow(/500/);

    expect(dier.calls).toBe(1); // no retry, no fallback: retrying duplicates text
    expect(delays).toHaveLength(0);
    expect(events).toEqual([{ type: 'delta', text: 'partial ' }]); // caller keeps what it got
  });

  it('falls back to the next provider after the chain step exhausts its retries', async () => {
    const primary = new FlakyProvider(99);
    const fallback = new ScriptedProvider(['fallback answer']);
    const { options: opts } = options({ providers: [primary, fallback], maxRetries: 1 });
    const events = await collect(new ResilientProvider(opts));

    expect(primary.calls).toBe(2); // 1 try + 1 retry, then the chain moves on
    expect(events.at(-1)).toMatchObject({ type: 'done', provider: 'scripted' });
  });

  it('honours Retry-After on 429, clamped — "wait 60s" is a fallback signal', async () => {
    const limited = new FlakyProvider(1, () => new LlmProviderError('HTTP 429', { provider: 'flaky', status: 429, retryable: true, retryAfterMs: 60_000 }));
    const { options: opts, delays } = options({ providers: [limited], retryAfterCapMs: 10_000 });
    await collect(new ResilientProvider(opts));
    expect(delays).toEqual([10_000]); // the cap, not the 60s the provider asked for
  });

  it('times out a provider that never produces a first token, then retries', async () => {
    const hangs = new HangsProvider();
    const { options: opts } = options({ providers: [hangs], maxRetries: 0, firstTokenTimeoutMs: 50 });
    await expect(collect(new ResilientProvider(opts))).rejects.toThrow(LlmTimeoutError);
    expect(hangs.calls).toBe(1);
  });

  it('never retries and never falls back on a prompt block — that is a policy decision, not resilience', async () => {
    class Blocked extends ScriptedProvider {
      calls = 0;
      override stream(): AsyncIterable<LlmEvent> {
        this.calls++;
        return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new PromptBlockedError('SAFETY', 'blocked')) }) };
      }
    }
    const blocked = new Blocked(['x']);
    const fallback = new ScriptedProvider(['should not be used']);
    const { options: opts, delays } = options({ providers: [blocked, fallback] });
    await expect(collect(new ResilientProvider(opts))).rejects.toThrow(PromptBlockedError);
    expect(blocked.calls).toBe(1);
    expect(delays).toHaveLength(0);
  });

  it('reports the MINIMUM contextWindow across the chain — the prompt was budgeted before any fallback', () => {
    const big = new ScriptedProvider(['x'], 32_000);
    const small = new ScriptedProvider(['x'], 4_096);
    const { options: opts } = options({ providers: [big, small] });
    const chain = new ResilientProvider(opts);
    expect(chain.contextWindow).toBe(4_096);
  });
});
