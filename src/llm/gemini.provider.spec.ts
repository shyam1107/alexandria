import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import { GeminiProvider } from './gemini.provider';
import { LlmProviderError, PromptBlockedError } from './llm.errors';
import type { Env } from '../config/env.schema';
import type { LlmEvent, Message } from './llm.types';

/**
 * The Gemini adapter's risk is the MAPPING, not the network — so tests run
 * against a local server replaying recorded SSE fixtures, and assert on the
 * exact request body the adapter produced. (Phase 5 verified ollama.com by
 * hand the same way; a live one-shot against the real Gemini API confirms
 * the fixture is honest — see workflow/notes.md.)
 */

let server: Server;
let baseUrl: string;
let lastRequest: { headers: Record<string, unknown>; body: Record<string, unknown> } | null = null;
let responder: (req: { body: Record<string, unknown> }, res: import('node:http').ServerResponse) => void = () => undefined;

function provider(): GeminiProvider {
  const values = {
    GEMINI_BASE_URL: baseUrl,
    GEMINI_MODEL: 'gemini-2.0-flash',
    GEMINI_API_KEY: 'test-key',
    GEMINI_NUM_CTX: 8192,
  } as Partial<Env>;
  return new GeminiProvider({ get: (key: keyof Env) => values[key] } as unknown as ConfigService<Env, true>);
}

async function collect(p: GeminiProvider, messages: Message[]): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const event of p.stream({ messages })) events.push(event);
  return events;
}

/** A canned SSE response. `chunks` are the data payloads; raw lines let tests omit the trailing newline. */
function sse(payloads: string[], { trail = true }: { trail?: boolean } = {}) {
  return payloads.map((p) => `data: ${p}\n\n`).join('') + (trail ? '' : '');
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      lastRequest = { headers: { ...req.headers }, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
      responder({ body: lastRequest.body }, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('GeminiProvider', () => {
  it('maps systemInstruction, alternates turns, and sends the key as a header', async () => {
    responder = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 } })]));
    };

    await collect(provider(), [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ]);

    // The key rides the header, never the query string — URLs end up in logs.
    expect(lastRequest!.headers['x-goog-api-key']).toBe('test-key');
    expect(lastRequest!.body.systemInstruction).toEqual({ parts: [{ text: 'Be terse.' }] });
    expect(lastRequest!.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'one' }] },
      { role: 'model', parts: [{ text: 'two' }] },
      { role: 'user', parts: [{ text: 'three' }] },
    ]);
  });

  it('streams deltas and takes usage from the LAST chunk that carries it', async () => {
    responder = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        sse([
          JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] }),
          JSON.stringify({ candidates: [{ content: { parts: [{ text: 'lo' }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1 } }),
          JSON.stringify({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2 } }),
        ]),
      );
    };

    const events = await collect(provider(), [{ role: 'user', content: 'hi' }]);
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe('Hello');
    expect(events.at(-1)).toEqual({
      type: 'done',
      usage: { promptTokens: 12, completionTokens: 2 },
      finishReason: 'length',
      model: 'gemini-2.0-flash',
      provider: 'gemini',
    });
  });

  it('bills thinking tokens as output — the live probe found the fixture could not', async () => {
    // Recorded from a real gemini-3.6-flash response: 39 prompt, 6 visible
    // candidate tokens, 118 THINKING tokens, and MAX_TOKENS after only 6
    // visible tokens because reasoning consumed the whole 128 budget.
    // thoughtsTokenCount is billed at output rates and is NOT included in
    // candidatesTokenCount, so counting only candidates understated this
    // call's output by 20x — and the cost ledger and the monthly quota both
    // inherit that error. The earlier fixture came from a non-reasoning
    // model, where the field does not exist at all; only a live call could
    // ever have surfaced this.
    responder = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        sse([
          JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Also 30 days' }] } }] }),
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '.' }] }, finishReason: 'MAX_TOKENS' }],
            usageMetadata: { promptTokenCount: 39, candidatesTokenCount: 6, thoughtsTokenCount: 118, totalTokenCount: 163 },
          }),
        ]),
      );
    };

    const events = await collect(provider(), [{ role: 'user', content: 'and for annual plans?' }]);
    const done = events.at(-1) as Extract<(typeof events)[number], { type: 'done' }>;
    expect(done.usage.promptTokens).toBe(39);
    expect(done.usage.completionTokens).toBe(124); // 6 visible + 118 thinking
    expect(done.finishReason).toBe('length');
  });

  it('still reports candidate tokens alone when a model declares no thinking', async () => {
    // The non-reasoning path must not regress: absent thoughtsTokenCount
    // contributes zero, never NaN.
    responder = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        sse([
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
          }),
        ]),
      );
    };
    const events = await collect(provider(), [{ role: 'user', content: 'hi' }]);
    const done = events.at(-1) as Extract<(typeof events)[number], { type: 'done' }>;
    expect(done.usage.completionTokens).toBe(3);
  });

  it('maps a zero-candidate safety block to PromptBlockedError — never an empty done', async () => {
    responder = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([JSON.stringify({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })]));
    };

    await expect(collect(provider(), [{ role: 'user', content: 'something awful' }])).rejects.toThrow(PromptBlockedError);
  });

  it('maps a mid-generation SAFETY finish to content_filter, keeping the text that arrived', async () => {
    responder = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'partial ' }] } }] }),
        JSON.stringify({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'SAFETY' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } }),
      ]));
    };

    const events = await collect(provider(), [{ role: 'user', content: 'hi' }]);
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'content_filter' });
  });

  it('treats a stream with candidates but no finishReason as truncated, not done', async () => {
    responder = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] })]));
    };

    await expect(collect(provider(), [{ role: 'user', content: 'hi' }])).rejects.toThrow(/finishReason/);
  });

  it('classifies 429 as retryable and parses Retry-After', async () => {
    responder = (_req, res) => {
      res.writeHead(429, { 'retry-after': '7' });
      res.end(JSON.stringify({ error: { message: 'quota exhausted' } }));
    };

    const error = await collect(provider(), [{ role: 'user', content: 'hi' }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmProviderError);
    expect((error as LlmProviderError).retryable).toBe(true);
    expect((error as LlmProviderError).retryAfterMs).toBe(7000);
    // The provider's own error text is drained into the message.
    expect((error as LlmProviderError).message).toContain('quota exhausted');
  });

  it('classifies 400 as our bug — non-retryable', async () => {
    responder = (_req, res) => {
      res.writeHead(400);
      res.end(JSON.stringify({ error: { message: 'Invalid JSON payload' } }));
    };

    const error = await collect(provider(), [{ role: 'user', content: 'hi' }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmProviderError);
    expect((error as LlmProviderError).retryable).toBe(false);
    expect((error as LlmProviderError).message).toContain('Invalid JSON payload');
  });

  it('rejects a conversation that does not start with a user turn', async () => {
    await expect(collect(provider(), [
      { role: 'system', content: 's' },
      { role: 'assistant', content: 'starts wrong' },
    ])).rejects.toThrow(/first non-system message/);
  });
});
