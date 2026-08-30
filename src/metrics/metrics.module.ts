import { Global, Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { TraceContextService } from './trace-context.service';
import { TraceMiddleware } from './trace.middleware';

/**
 * Global: the metrics service is a cross-cutting sink — the ledger, the
 * chat controller, and the HTTP interceptor all record into it without
 * importing wiring.
 *
 * /metrics is deliberately NOT behind auth: Prometheus scrapes with a
 * bearer token in production, but that is deployment config (Phase 9), not
 * application code. The endpoint exposes counters and histograms only —
 * no document content, no prompts, no tenant ids (see the cardinality
 * rule on MetricsService). Network-level restriction is the deploy's job.
 */
@Global()
@Module({
  providers: [MetricsService, TraceContextService, TraceMiddleware],
  controllers: [MetricsController],
  exports: [MetricsService, TraceContextService],
})
export class MetricsModule implements NestModule {
  constructor(private readonly traces: TraceContextService) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}