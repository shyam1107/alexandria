import { Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessTokenGuard, WorkspaceMemberGuard } from '../auth/auth.guards';
import type { RequestWithAuth } from '../auth/auth.types';
import { ChatService, type ChatSink } from './chat.service';
import { ChatDto } from './dto/chat.dto';

const HEARTBEAT_MS = 15_000;

/**
 * POST + SSE over a raw response. Nest's @Sse() is built for GET + RxJS and
 * global interceptors serialize over it; with a POST body it fights you, so
 * this controller writes bytes itself. The SERVICE owns the event grammar.
 */
@Controller('chat')
@UseGuards(AccessTokenGuard, WorkspaceMemberGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

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

    // Heartbeat comments: a cold model load is 10–30s before the first
    // delta, and idle proxies kill connections at 30–60s.
    const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);
    try {
      await this.chat.streamChat(request.workspaceId!, request.user!.userId, body, sink, abort.signal);
    } catch (error) {
      if (!started) {
        const status = error instanceof Error && 'status' in error ? (error as { status: number }).status : 502;
        response.status(status).json({ message: error instanceof Error ? error.message : 'Chat failed' });
        return;
      }
      sink.event('error', { message: 'Chat failed before the stream completed' });
    } finally {
      clearInterval(heartbeat);
      if (!response.writableEnded) response.end();
    }
  }
}
