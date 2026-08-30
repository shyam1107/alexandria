import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

/**
 * Counts every HTTP request by route and status class at the boundary.
 *
 * WHY AN INTERCEPTOR: the controller-return path is only half the story —
 * guards throw (429, 402, 401), pipes throw (400), and those never reach
 * controller code. Nest runs interceptors AROUND the whole handler chain
 * including guards, so this is the one place that sees every outcome with
 * its final status.
 *
 * WHY route, not full path: /documents/:id/complete as a raw path is
 * unbounded cardinality (one label per uuid ever seen — the exact trap the
 * cardinality rule exists to prevent). The route TEMPLATE is bounded: one
 * label value per endpoint this app defines.
 *
 * SSE note: a streaming response's status is committed on the FIRST frame,
 * so a mid-stream failure still counts as 2xx here — by design. The
 * pre-frame metric is what separates "the stream started" from "the
 * stream failed later"; this counter separates "the request was admitted
 * as 200" from "rejected before framing", which is precisely the
 * distinction the (a)+(c) heartbeat decision protects.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { route?: string }>();
    const route = request.route?.path ?? 'unmatched';
    const started = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.record(route, context, started),
        error: () => this.record(route, context, started),
      }),
    );
  }

  private record(route: string, context: ExecutionContext, started: number): void {
    const response = context.switchToHttp().getResponse<Response>();
    const status = response.statusCode;
    this.metrics.recordHttp(route, status);
    // The chat pre-frame window, when the route is chat: from arrival to
    // first frame or failure — the histogram the 20s deadline's headroom
    // is measured against (WS8's p95 comes from here).
    if (route === '/api/v1/chat') {
      this.metrics.observePreFrame((Date.now() - started) / 1000, status < 400 ? 'first_frame' : 'failed');
    }
  }
}