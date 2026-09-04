import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { MetricsCoreModule } from './metrics-core.module';
import { MetricsController } from './metrics.controller';
import { TraceContextService } from './trace-context.service';
import { TraceMiddleware } from './trace.middleware';

/**
 * The HTTP half of metrics: the scrape endpoint and the request-scoped
 * trace middleware. API process only — the worker imports MetricsCoreModule
 * instead, which carries the sinks without the controller.
 *
 * /metrics is deliberately NOT behind auth: Prometheus scrapes with a
 * bearer token in production, but that is deployment config (Phase 9), not
 * application code. The endpoint exposes counters and histograms only —
 * no document content, no prompts, no tenant ids (see the cardinality
 * rule on MetricsService). Network-level restriction is the deploy's job.
 */
@Module({
  imports: [MetricsCoreModule],
  controllers: [MetricsController],
  providers: [TraceMiddleware],
})
export class MetricsModule implements NestModule {
  constructor(private readonly traces: TraceContextService) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
