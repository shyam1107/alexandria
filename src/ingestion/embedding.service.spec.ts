import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { EmbeddingService } from './embedding.service';
import type { Env } from '../config/env.schema';
import type { UsageEntry, UsageLedger } from '../llm/usage-ledger';

/**
 * Embedding resilience: retries with jittered backoff, a plain per-request
 * timeout (embeddings are single request/response — no first-token/idle
 * split), the drained-body fix, and a ledger row for every outcome. fetch is
 * stubbed globally; retry delays go through the service's sleep seam.
 */

const WORKSPACE = '11111111-1111-1111-1111-111111111111';
const CONTEXT = { workspaceId: WORKSPACE, operation: 'embedding_query' as const };
const VECTOR = Array.from({ length: 768 }, (_, i) => i / 768);

function makeService(overrides: Partial<Env> = {}) {
  const values = {
    EMBEDDING_BASE_URL: 'http://embeddings.test',
    EMBEDDING_MODEL: 'nomic-embed-text',
    EMBEDDING_DIMENSIONS: 768,
    EMBEDDING_TIMEOUT_MS: 5_000,
    EMBEDDING_MAX_RETRIES: 2,
    ...overrides,
  } as Partial<Env>;
  const entries: Array<{ workspaceId: string; entry: UsageEntry }> = [];
  const ledger = { record: async (workspaceId: string, entry: UsageEntry) => entries.push({ workspaceId, entry }) } as unknown as UsageLedger;
  const service = new EmbeddingService({ get: (key: keyof Env) => values[key] } as unknown as ConfigService<Env, true>, ledger);
  const delays: number[] = [];
  service.sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { service, entries, delays };
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body), json: async () => body } as Response;
}

function errorResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return { ok: false, status, headers: new Headers(headers), text: async () => body, json: async () => ({}) } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('EmbeddingService', () => {
  it('embeds and records a ledger row for the call', async () => {
    const fetchMock = vi.fn(async () => okResponse({ embedding: VECTOR }));
    vi.stubGlobal('fetch', fetchMock);
    const { service, entries } = makeService();

    const embedding = await service.embed('refund policy', CONTEXT);

    expect(embedding).toHaveLength(768);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(entries).toEqual([
      { workspaceId: WORKSPACE, entry: expect.objectContaining({ operation: 'embedding_query', provider: 'ollama', model: 'nomic-embed-text', success: true }) },
    ]);
  });

  it('retries retryable failures (5xx) with backoff, then succeeds', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++calls <= 2 ? errorResponse(500, 'overload') : okResponse({ embedding: VECTOR }))));
    const { service, entries, delays } = makeService();

    const embedding = await service.embed('refund policy', CONTEXT);

    expect(embedding).toHaveLength(768);
    expect(calls).toBe(3);
    expect(delays).toHaveLength(2);
    expect(entries.at(-1)!.entry.success).toBe(true);
  });

  it('never retries a 4xx — a bad request is our bug, not a transient', async () => {
    const fetchMock = vi.fn(async () => errorResponse(400, 'bad input'));
    vi.stubGlobal('fetch', fetchMock);
    const { service, entries, delays } = makeService();

    await expect(service.embed('x', CONTEXT)).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toHaveLength(0);
    expect(entries).toEqual([{ workspaceId: WORKSPACE, entry: expect.objectContaining({ success: false, errorKind: 'provider_error' }) }]);
  });

  it('times out a hung provider and records the failure as a timeout', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      // The service always passes AbortSignal.timeout(...), so the listener
      // is what the deadline fires into.
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    })));
    const { service, entries } = makeService({ EMBEDDING_TIMEOUT_MS: 10, EMBEDDING_MAX_RETRIES: 1 });

    await expect(service.embed('x', CONTEXT)).rejects.toThrow();
    expect(entries.at(-1)!.entry).toMatchObject({ success: false, errorKind: 'timeout' });
  });

  it('drains the error body — the provider’s text is the only useful diagnostic', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(404, 'model "nomic-embed-text" not found')));
    const { service } = makeService({ EMBEDDING_MAX_RETRIES: 0 });

    await expect(service.embed('x', CONTEXT)).rejects.toThrow(/not found/);
  });

  it('rejects a dimension mismatch — a wrong-shaped vector would corrupt the index silently', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ embedding: [1, 2, 3] })));
    const { service } = makeService({ EMBEDDING_MAX_RETRIES: 0 });

    await expect(service.embed('x', CONTEXT)).rejects.toThrow(/dimension mismatch/);
  });
});
