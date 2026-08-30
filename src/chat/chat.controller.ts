import { Body, Controller, HttpException, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Env } from '../config/env.schema';
import { AccessTokenGuard, WorkspaceMemberGuard } from '../auth/auth.guards';
import type { RequestWithAuth } from '../auth/auth.types';
import { PreFrameDeadlineError } from './chat.errors';
import { ChatRateLimitGuard } from './chat-rate-limit.guard';
import { QuotaGuard } from './quota.guard';
import { RateLimiterService } from '../rate-limit/rate-limiter.service';
import { ChatService, type ChatSink } from './chat.service';
import { ChatDto } from './dto/chat.dto';

/**
 * POST + SSE over a raw response. Nest's @Sse() is built for GET + RxJS and
 * global interceptors serialize over it; with a POST body it fights you, so
 * this controller writes bytes itself. The SERVICE owns the event grammar.
 *
 * TWO timers guard the request, and their arming order is the Phase 7 contract:
 *
 * 1. The PRE-FRAME DEADLINE covers everything that must finish while the
 *    status line is still ours: conversation resolution, idempotent replay,
 *    history, the rewrite, retrieval. Phase 5 deliberately deferred headers
 *    to the first frame so those failures stay real HTTP errors; the deadline
 *    bounds how long that can take, so the error the client receives is
 *    decided by us (503), not by a proxy idle timeout (a cut connection).
 *    It disarms the moment the first frame is written — after that, a long
 *    answer is legitimate and mid-stream failures are error frames by the
 *    SSE grammar.
 *
 * 2. The HEARTBEAT is armed WITH the first frame, never at handler entry —
 *    the Phase 7 race. A ping calls the same lazy write that commits the 200,
 *    so a timer armed before the first frame could commit the status line
 *    before the handler has decided what it is: retrieval outliving one
 *    heartbeat interval turned a real HTTP error into an SSE error frame,
 *    with the outcome decided by whether a timer beat a database query. A
 *    deterministic contract beats a favourable one.
 */
@Controller('chat')
@UseGuards(AccessTokenGuard, WorkspaceMemberGuard, ChatRateLimitGuard, QuotaGuard)
export class ChatController {
  private readonly heartbeatMs: number;
  private readonly preFrameDeadlineMs: number;

  constructor(
    private readonly chat: ChatService,
    private readonly limiter: RateLimiterService,
    config: ConfigService<Env, true>,
  ) {
    this.heartbeatMs = config.get('CHAT_HEARTBEAT_MS', { infer: true });
    this.preFrameDeadlineMs = config.get('CHAT_PRE_FRAME_DEADLINE_MS', { infer: true });
  }

  @Post()
  async stream(@Req() request: Request & RequestWithAuth, @Body() body: ChatDto, @Res() response: Response): Promise<void> {
    const abort = new AbortController();
    // The RESPONSE is what tells us the client left, never the request.
    //
    // IncomingMessage emits 'close' when the request is COMPLETE, not only
    // when the peer vanishes — and express.json() drains the body before this
    // handler runs. Measured on express 5.2.1: req 'close' at 2ms, res
    // 'close' at 1009ms when the response genuinely ended. So req.on('close')
    // is a race against handler registration, and both outcomes are wrong:
    // register first and every request aborts itself milliseconds in; register
    // after (what happens here, since WorkspaceMemberGuard does a query
    // before the handler) and the listener is dead, so a client that walks
    // away never cancels anything and we generate tokens for nobody.
    // chat.controller.spec covers both directions.
    response.on('close', () => {
      if (!response.writableEnded) abort.abort();
    });

    // Headers go out with the FIRST frame, not before: an error raised
    // during retrieval (before any byte) must still be a real HTTP error.
    let started = false;
    const write = (chunk: string) => {
      if (!started) {
        started = true;
        clearTimeout(preFrameTimer);
        heartbeat = setInterval(() => write(': ping\n\n'), this.heartbeatMs);
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          // Without this, nginx buffers the stream and it "works locally,
          // breaks in prod".
          'x-accel-buffering': 'no',
        });
      }
      if (!response.writableEnded) response.write(chunk);
    };
    const sink: ChatSink = { event: (name, data) => write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`) };

    // The pre-frame deadline: armed BEFORE the service runs, disarmed inside
    // write() when the first frame commits. Aborting with a REASON is the
    // Phase 6 pattern — it keeps "our deadline fired" distinguishable from
    // "the client hung up", which the persistence path reads differently.
    //
    // The await is a RACE, not a bare await: cooperative cancellation needs
    // every awaited operation to actually observe the signal, and the
    // deadline must not depend on that chain being unbroken all the way down
    // (a hung DB driver, a provider that ignores the signal). If nothing
    // starts the stream before the deadline, the deadline wins and the
    // client gets a real 503 — deterministically, not "as soon as something
    // downstream happens to throw".
    let heartbeat: NodeJS.Timeout | undefined;
    let preFrameTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      preFrameTimer = setTimeout(() => {
        abort.abort(new PreFrameDeadlineError());
        reject(new PreFrameDeadlineError());
      }, this.preFrameDeadlineMs);
    });
    try {
      await Promise.race([this.chat.streamChat(request.workspaceId!, request.user!.userId, body, sink, abort.signal), deadline]);
    } catch (error) {
      if (!started) {
        // Only HTTP exceptions keep their message: relaying a raw
        // error.message would happily hand the client a Postgres error
        // string or a vendor response body. Everything else is generic.
        if (error instanceof HttpException) {
          response.status(error.getStatus()).json({ message: error.message });
          return;
        }
        // Our own deadline is a 503 — a transient "the pipeline could not
        // start in time", not the client's fault and not a provider outage
        // we want lumped into generic 502s in the status-class metric.
        if (error instanceof PreFrameDeadlineError) {
          response.status(503).json({ message: 'Chat failed to start in time' });
          return;
        }
        response.status(502).json({ message: 'Chat failed' });
        return;
      }
      sink.event('error', { message: 'Chat failed before the stream completed' });
    } finally {
      clearTimeout(preFrameTimer);
      if (heartbeat) clearInterval(heartbeat);
      // Early lease release for a cleanly-ended stream; the lease TTL covers
      // the crash case. Guard-thrown denials never registered a lease.
      if (request.streamLease) await this.limiter.releaseLease(request.streamLease.key, request.streamLease.id);
      if (!response.writableEnded) response.end();
    }
  }
}