import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import { OllamaProvider } from './ollama.provider';
import { LlmProviderError } from './llm.errors';
import type { Env } from '../config/env.schema';
import type { LlmEvent } from './llm.types';

/**
 * Ollama's NDJSON framing against a local server. Two of these are
 * regression tests for Phase 5 defects found in review: the residual-buffer
 * drop (a final line with no trailing newline — usually the `done` line,
 * i.e. the one carrying usage) and the undrained error body (connection
 * leak + "404 missing model indistinguishable from a 500").
 */

let server: Server;
let baseUrl: string;
let responder: (res: import('node:http').ServerResponse) => void = () => undefined;

function provider(): OllamaProvider {
  const values = {
    OLLAMA_BASE_URL: baseUrl,
    GENERATION_MODEL: 'gpt-oss:120b',
    OLLAMA_API_KEY: undefined,
    GENERATION_NUM_CTX: 8192,
  } as Partial<Env>;
  return new OllamaProvider({ get: (key: keyof Env) => values[key] } as unknown as ConfigService<Env, true>);
}

async function collect(p: OllamaProvider): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const event of p.stream({ messages: [{ role: 'user', content: 'hi' }] })) events.push(event);
  return events;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume(); // drain the request body regardless of the response path
    req.on('end', () => responder(res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('OllamaProvider', () => {
  it('parses a final NDJSON line with no trailing newline — that line is usually the usage', async () => {
    responder = (res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      // No trailing \n on the done line. Pre-fix, this done event (and its
      // usage) was silently discarded.
      res.end(
        `${JSON.stringify({ message: { role: 'assistant', content: 'hi' }, done: false })}\n` +
          JSON.stringify({ model: 'gpt-oss:120b', done: true, done_reason: 'stop', prompt_eval_count: 42, eval_count: 7 }),
      );
    };

    const events = await collect(provider());
    expect(events.at(-1)).toEqual({
      type: 'done',
      usage: { promptTokens: 42, completionTokens: 7 },
      finishReason: 'stop',
      model: 'gpt-oss:120b',
      provider: 'ollama',
    });
  });

  it('drains a non-OK body and includes the provider’s own error text', async () => {
    responder = (res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'model "gpt-oss:120b" not found' }));
    };

    const error = await collect(provider()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmProviderError);
    expect((error as Error).message).toContain('not found'); // 404 missing model ≠ 500
    expect((error as LlmProviderError).retryable).toBe(false);
  });

  it('classifies 429/5xx as retryable and parses Retry-After', async () => {
    responder = (res) => {
      res.writeHead(429, { 'retry-after': '3' });
      res.end('slow down');
    };

    const error = await collect(provider()).catch((e: unknown) => e);
    expect((error as LlmProviderError).retryable).toBe(true);
    expect((error as LlmProviderError).retryAfterMs).toBe(3000);
  });

  it('treats a stream ending without a terminal frame as truncated and retryable', async () => {
    responder = (res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(`${JSON.stringify({ message: { role: 'assistant', content: 'partial' }, done: false })}\n`);
    };

    const events: LlmEvent[] = [];
    await expect(
      (async () => {
        for await (const event of provider().stream({ messages: [{ role: 'user', content: 'hi' }] })) events.push(event);
      })(),
    ).rejects.toThrow(/terminal frame/);
    expect(events).toEqual([{ type: 'delta', text: 'partial' }]);
  });
});
