import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { TraceContextService } from './trace-context.service';

/**
 * Binds a trace id to every request. Incoming x-request-id is honoured so a
 * caller (a gateway, another service) keeps ITS trace through this process;
 * otherwise a fresh id. The id is echoed back on the response so a client
 * can quote it in a bug report — the cheapest support tooling there is.
 *
 * The SAME id is echoed and bound: generating one id for the context and a
 * different one (or 'unset') for the header would break the correlation
 * this whole mechanism exists for.
 */
@Injectable()
export class TraceMiddleware implements NestMiddleware {
  constructor(private readonly traces: TraceContextService) {}

  use(request: Request & { requestId?: string }, response: Response, next: NextFunction): void {
    const incoming = request.headers['x-request-id'];
    const id = (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
    response.setHeader('x-request-id', id);
    request.requestId = id;
    this.traces.run(id, () => next());
  }
}