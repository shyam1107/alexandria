import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { TraceContextService } from './trace-context.service';

/**
 * The process-agnostic half of metrics: the counter sink and the trace
 * store, with no HTTP surface.
 *
 * Split out for the same reason IngestionCoreModule exists. The worker
 * needs MetricsService (UsageLedger records ledger-write failures into it)
 * and TraceContextService (DocumentService and the ingestion worker thread
 * a trace id through the job payload), but it must not import
 * MetricsModule, which carries the /metrics controller and the HTTP trace
 * middleware — "keep HTTP concerns out of worker modules".
 *
 * Global for the reason the old combined module was: these are cross-cutting
 * sinks that business logic records into without importing wiring. Note that
 * @Global() only means "no re-import once loaded" — the module must still
 * appear in each root graph, which is why IngestionCoreModule imports it
 * explicitly rather than relying on AppModule having done so.
 */
@Global()
@Module({
  providers: [MetricsService, TraceContextService],
  exports: [MetricsService, TraceContextService],
})
export class MetricsCoreModule {}
