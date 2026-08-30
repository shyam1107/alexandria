import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { ChatController } from '../src/chat/chat.controller';
import { ChatService, type ChatSink } from '../src/chat/chat.service';
import { AccessTokenGuard, WorkspaceMemberGuard } from '../src/auth/auth.guards';
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

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

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
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [{ provide: ChatService, useValue: service }],
    })
      // The guards are Phase 2's and are tested there; here they only need to
      // populate the request the way a real authenticated call would.
      .overrideGuard(AccessTokenGuard)
      .useValue({
        canActivate: (context: { switchToHttp: () => { getRequest: () => RequestWithAuth } }) => {
          context.switchToHttp().getRequest().user = { userId: USER_ID, email: 'chat-controller@example.com' };
          return true;
        },
      })
      .overrideGuard(WorkspaceMemberGuard)
      .useValue({
        canActivate: (context: { switchToHttp: () => { getRequest: () => RequestWithAuth } }) => {
          context.switchToHttp().getRequest().workspaceId = WORKSPACE_ID;
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    // Mirror main.ts so the route and body handling match production.
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    url = `http://127.0.0.1:${port}/api/v1/chat`;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

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
      throw Object.assign(new Error('Conversation not found'), { status: 404 });
    };
    const response = await post({ message: 'missing conversation' });

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
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
});
