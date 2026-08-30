import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundException, ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { ChatController } from '../src/chat/chat.controller';
import { ChatService, type ChatSink } from '../src/chat/chat.service';
import { AccessTokenGuard, WorkspaceMemberGuard } from '../src/auth/auth.guards';
import { ChatRateLimitGuard } from '../src/chat/chat-rate-limit.guard';
import { QuotaGuard } from '../src/chat/quota.guard';
import { UsageLedger } from '../src/llm/usage-ledger';
import { RateLimiterService } from '../src/rate-limit/rate-limiter.service';
import type { RequestWithAuth } from '../src/auth/auth.types';

/**
 * The controller over a REAL socket, because that is the only place its bugs
 * can exist. Everything the service does is covered by chat.integration.spec;
 * what is exercised here is the part that only shows up on the wire — SSE
 * framing, the header contract, and above all which event actually means
 * "the client went away".
 *
 * That last one is not hypothetical. `request.on('close')` fires as soon as
 * the request is COMPLETE, and express.json() drains the body before the
 * handler runs (measured on express 5.2.1: 2ms). Whether that lands before or
 * after the handler registers its listener is a race, and both sides lose:
 * early and every request cancels itself, late and the listener is dead so
 * disconnects cancel nothing. This app took the second branch. No
 * service-level test could see either: they hand streamChat their own
 * AbortController.
 */

const WORKSPACE_ID = '11111111-1111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

// The controller reads CHAT_HEARTBEAT_MS and CHAT_PRE_FRAME_DEADLINE_MS from
// config. Tests pin them tight so deadlines fire inside a test's lifetime;
// production defaults (15s / 20s) are far too slow to wait for.
const controllerConfig = (overrides: { CHAT_PRE_FRAME_DEADLINE_MS?: number } = {}) => {
  const values: Record<string, number> = {
    CHAT_HEARTBEAT_MS: 2_000,
    CHAT_PRE_FRAME_DEADLINE_MS: 10_000,
    ...overrides,
  };
  return { get: (key: string): number => values[key] } as never;
};

/** Records what the service saw, so tests can assert on the signal it was handed. */
class FakeChatService {
  abortedDuringStream: boolean | null = null;
  sawAbort = false;
  behaviour: (sink: ChatSink, signal: AbortSignal) => Promise<void> = async (sink) => {
    sink.event('sources', { sources: [] });
    sink.event('done', { finishReason: 'stop' });
  };

  async streamChat(_workspaceId: string, _userId: string, _dto: unknown, sink: ChatSink, signal: AbortSignal): Promise<void> {
    signal.addEventListener('abort', () => {
      this.sawAbort = true;
    });
    return this.behaviour(sink, signal);
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('POST /chat (SSE over a real socket)', () => {
  let app: INestApplication;
  let url: string;
  let service: FakeChatService;

  beforeAll(async () => {
    service = new FakeChatService();
    ({ app, url } = await buildApp());
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  /**
   * Boots the controller over a real socket with the given config overrides.
   * The shared beforeAll uses defaults; deadline tests build a private
   * instance with a tight CHAT_PRE_FRAME_DEADLINE_MS so they finish fast.
   */
  async function buildApp(overrides: { CHAT_PRE_FRAME_DEADLINE_MS?: number } = {}) {
    // The shared app injects `service`, whose behaviour tests mutate per-case.
    // A deadline-override app gets its own FakeChatService (whose default
    // behaviour is overridden by the test) so it cannot interfere with the
    // shared one.
    const instance = overrides.CHAT_PRE_FRAME_DEADLINE_MS === undefined ? service : new FakeChatService();
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: instance },
        { provide: ConfigService, useValue: controllerConfig(overrides) },
        // The real limiter needs Redis; the controller only uses it to
        // release the stream lease in finally. The limiter's behaviour is
        // covered by its own integration suite against real Redis.
        { provide: RateLimiterService, useValue: { releaseLease: async () => undefined } },
      ],
    })
      .overrideGuard(AccessTokenGuard)
      .useValue({
        canActivate: (context: { switchToHttp: () => { getRequest: () => RequestWithAuth } }) => {
          context.switchToHttp().getRequest().user = { userId: USER_ID, email: 'chat-controller@example.com' };
          return true;
        },
      })
      // The rate-limit guard is Phase 7's and has its own integration suite
      // (rate-limit.integration.spec); here it would need a real Redis, so
      // it is overridden to plain-allow, exactly like the Phase 2 guards.
      .overrideGuard(ChatRateLimitGuard)
      .useValue({ canActivate: () => true })
      // Same for the quota guard: quota behaviour is covered by
      // quota.integration.spec against real Redis + Postgres.
      .overrideGuard(QuotaGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(WorkspaceMemberGuard)
      .useValue({
        canActivate: (context: { switchToHttp: () => { getRequest: () => RequestWithAuth } }) => {
          context.switchToHttp().getRequest().workspaceId = WORKSPACE_ID;
          return true;
        },
      })
      .compile();

    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api/v1/chat`;
    const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { app, url, post, instance };
  }

  const post = (body: unknown, init: RequestInit = {}) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init });

  it('does not abort while the client is still connected', async () => {
    // Guards the first branch of the race: if the abort listener ever catches
    // the request's own completion event, this reads true and the client gets
    // a sources frame followed by silence.
    service.abortedDuringStream = null;
    service.behaviour = async (sink, signal) => {
      sink.event('sources', { sources: [{ n: 1 }] });
      await delay(150);
      service.abortedDuringStream = signal.aborted;
      sink.event('delta', { text: 'hello' });
      sink.event('usage', { promptTokens: 1, completionTokens: 1 });
      sink.event('done', { finishReason: 'stop' });
    };

    const response = await post({ message: 'still there?' });
    const body = await response.text();

    expect(service.abortedDuringStream).toBe(false);
    expect(response.status).toBe(200);
    expect(body).toContain('event: delta');
    expect(body).toContain('event: done');
  });

  it('sets the SSE headers, including the one nginx needs', async () => {
    service.behaviour = async (sink) => {
      sink.event('sources', { sources: [] });
      sink.event('done', { finishReason: 'stop' });
    };
    const response = await post({ message: 'headers' });
    await response.text();

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    // Without this nginx buffers the stream and it "works locally, breaks in prod".
    expect(response.headers.get('x-accel-buffering')).toBe('no');
  });

  it('frames events as parseable SSE in grammar order', async () => {
    service.behaviour = async (sink) => {
      sink.event('sources', { sources: [{ n: 1, documentTitle: 'Refund policy' }] });
      sink.event('delta', { text: 'Within 30 days ' });
      sink.event('delta', { text: '[1].' });
      sink.event('usage', { promptTokens: 12, completionTokens: 4 });
      sink.event('done', { finishReason: 'stop' });
    };
    const body = await (await post({ message: 'refund?' })).text();

    const events = [...body.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events).toEqual(['sources', 'delta', 'delta', 'usage', 'done']);
    const deltas = [...body.matchAll(/^event: delta\ndata: (.+)$/gm)].map((m) => JSON.parse(m[1]).text);
    expect(deltas.join('')).toBe('Within 30 days [1].');
  });

  // The branch this app actually had: the listener was registered too late to
  // ever fire, so a client walking away cancelled nothing and generation ran
  // on for an audience of no one. Fails on req.on('close').
  it('aborts the generation when the client actually disconnects', async () => {
    service.sawAbort = false;
    service.behaviour = async (sink, signal) => {
      sink.event('sources', { sources: [] });
      for (let i = 0; i < 40 && !signal.aborted; i += 1) {
        sink.event('delta', { text: `tok${i} ` });
        await delay(25);
      }
    };

    const controller = new AbortController();
    const response = await post({ message: 'leaving early' }, { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read(); // first bytes land, then the client walks away
    controller.abort();
    await reader.cancel().catch(() => undefined);

    await delay(150);
    expect(service.sawAbort).toBe(true);
  });

  it('reports a pre-stream failure as a real HTTP error, not a 200 with an error frame', async () => {
    // Nothing has been written yet, so the status line is still ours to set.
    service.behaviour = async () => {
      throw new NotFoundException('Conversation not found');
    };
    const response = await post({ message: 'missing conversation' });

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('never leaks a raw internal error message to the client', async () => {
    // Only Nest HttpExceptions keep their message and status. A plain Error
    // — even one carrying a status property, which is how this regression
    // presented — becomes a generic 502: the raw text could be a Postgres
    // error string or a vendor response body.
    service.behaviour = async () => {
      throw Object.assign(new Error('relation "conversations" does not exist'), { status: 404 });
    };
    const response = await post({ message: 'internal explosion' });
    const body = (await response.json()) as { message: string };

    expect(response.status).toBe(502);
    expect(body.message).toBe('Chat failed');
  });

  it('degrades a mid-stream failure to an error frame, since 200 is already sent', async () => {
    service.behaviour = async (sink) => {
      sink.event('sources', { sources: [] });
      sink.event('delta', { text: 'partial' });
      throw new Error('provider exploded');
    };
    const response = await post({ message: 'fails halfway' });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('event: error');
    expect(body).not.toContain('provider exploded');
  });

  /**
   * THE PHASE 7 HEARTBEAT CONTRACT. The ping and the first frame share the
   * same lazy write that commits the 200 — so a heartbeat armed at handler
   * entry could commit the status line before the handler decided what it
   * was, converting a retrieval failure into a 200 + error frame depending
   * on whether a timer beat a database query. The fix: arm the heartbeat
   * WITH the first frame. The observable contract, asserted over a real
   * socket: a service that sits silent well past one heartbeat interval
   * BEFORE the first frame sends NOTHING (no ping commits the 200), and a
   * real HTTP error can still follow.
   *
   * Proven to bite: arming the heartbeat at handler entry makes this test
   * fail — the ping writes ': ping' and commits the 200 before the service
   * throws, so the response becomes 200 + error frame instead of 503.
   */
  it('never lets a heartbeat commit the status before the first frame', async () => {
    // Heartbeat interval is 2000ms (pinned in controllerConfig). The service
    // stays silent 2500ms — past one full interval — then fails.
    service.behaviour = async () => {
      await delay(2_500);
      throw new Error('retrieval was slow and then it failed');
    };
    const response = await post({ message: 'slow then failing' });
    const body = await response.text();

    // Not 200: no ping may commit the status line while the handler is still
    // deciding. And no ping bytes on the wire at all.
    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body).not.toContain(': ping');
  });

  /**
   * The pre-frame deadline (option c): a request that cannot start in time
   * is OUR error, decided by us, not a proxy idle-timeout cut. 503 — the
   * pipeline could not start — not 502, so status-class metrics distinguish
   * "slow start" from "failure".
   *
   * Proven to bite: removing the deadline timer leaves this test hanging on
   * the client until its own fetch times out.
   */
  it('cuts a pre-frame stall with a real 503 before the first frame', async () => {
    // The service never emits a frame and never returns; the deadline (pinned
    // at 300ms for this test via its own app instance) must cut it.
    const stall = await buildApp({ CHAT_PRE_FRAME_DEADLINE_MS: 300 });
    (stall.instance as FakeChatService).behaviour = () => new Promise<void>(() => undefined);
    const response = await stall.post({ message: 'stall forever' });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { message: string };
    expect(body.message).toBe('Chat failed to start in time');
    await stall.app.close();
  });

  /**
   * The Phase 7 rate-limit contract, end to end: a denied request is a real
   * HTTP 429 BEFORE any SSE frame — the guard chain must fire ahead of the
   * handler, so the lazy 200-commit is never reached. This is the exact
   * placement property the heartbeat work protects, asserted from the wire.
   */
  it('answers a rate-limited chat with a real 429, not an SSE error frame', async () => {
    const { Redis } = await import('ioredis');
    const redis = new Redis(process.env.REDIS_URL!);
    try {
      // Simulate a workspace at its concurrent-stream cap: 5 live leases.
      for (let i = 0; i < 5; i++) await redis.zadd(`rl:chat:streams:${WORKSPACE_ID}`, Date.now() + 60_000, `spec-${i}`);

      const moduleRef = await Test.createTestingModule({
        controllers: [ChatController],
        providers: [
          { provide: ChatService, useValue: service },
          { provide: ConfigService, useValue: controllerConfig() },
          { provide: RateLimiterService, useValue: new RateLimiterService(redis) },
          // The quota guard sits AFTER the rate-limit guard in the chain;
          // the 429 must fire before quota is even consulted. Stubbed to
          // allow — quota denial has its own test.
          { provide: UsageLedger, useValue: { withinBudget: async () => true, record: async () => undefined, consumedSoFar: async () => 0 } },
        ],
      })
        .overrideGuard(AccessTokenGuard)
        .useValue({ canActivate: (context: { switchToHttp: () => { getRequest: () => RequestWithAuth } }) => { context.switchToHttp().getRequest().user = { userId: USER_ID, email: 'x@example.com' }; return true; } })
        .overrideGuard(WorkspaceMemberGuard)
        .useValue({ canActivate: (context: { switchToHttp: () => { getRequest: () => RequestWithAuth } }) => { context.switchToHttp().getRequest().workspaceId = WORKSPACE_ID; return true; } })
        .compile();

      const rlApp = moduleRef.createNestApplication();
      rlApp.setGlobalPrefix('api');
      rlApp.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
      rlApp.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      await rlApp.init();
      await rlApp.listen(0);
      const { port } = rlApp.getHttpServer().address() as AddressInfo;

      const response = await fetch(`http://127.0.0.1:${port}/api/v1/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'limit me' }),
      });
      const text = await response.text();

      expect(response.status).toBe(429);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(text).not.toContain('event:');

      await rlApp.close();
    } finally {
      await redis.del(`rl:chat:streams:${WORKSPACE_ID}`);
      await redis.quit();
    }
  });

  /**
   * Quota exhaustion, end to end: an over-budget workspace gets a real 402
   * BEFORE any SSE frame — pre-frame placement, same contract as the 429.
   * 402, not 429: "budget exhausted" is a plan state, not a rate problem.
   */
  it('answers an over-budget workspace with a real 402, not an SSE error frame', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: service },
        { provide: ConfigService, useValue: controllerConfig() },
        { provide: RateLimiterService, useValue: { releaseLease: async () => undefined, consume: async () => true, acquireLease: async () => true, checkLogin: async () => true } },
        { provide: UsageLedger, useValue: { withinBudget: async () => false, record: async () => undefined, consumedSoFar: async () => 999_999_999 } },
      ],
    })
      .overrideGuard(AccessTokenGuard)
      .useValue({ canActivate: (context: { switchToHttp: () => { getRequest: () => RequestWithAuth } }) => { context.switchToHttp().getRequest().user = { userId: USER_ID, email: 'x@example.com' }; return true; } })
      .overrideGuard(WorkspaceMemberGuard)
      .useValue({ canActivate: (context: { switchToHttp: () => { getRequest: () => RequestWithAuth } }) => { context.switchToHttp().getRequest().workspaceId = WORKSPACE_ID; return true; } })
      .compile();

    const quotaApp = moduleRef.createNestApplication();
    quotaApp.setGlobalPrefix('api');
    quotaApp.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    quotaApp.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await quotaApp.init();
    await quotaApp.listen(0);
    const { port } = quotaApp.getHttpServer().address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'budget me' }),
    });
    const text = await response.text();

    expect(response.status).toBe(402);
    expect(text).not.toContain('event:');

    await quotaApp.close();
  });
});
