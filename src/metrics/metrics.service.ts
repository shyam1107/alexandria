import { Injectable, Logger } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Phase 7 observability. THREE metric families, and the cardinality rule
 * that decides everything:
 *
 * THE RULE: a metric LABEL may only carry values from a small, known set.
 * `workspace_id` is NEVER a label — a thousand tenants times a dozen
 * labels is tens of thousands of active time series, which takes a
 * Prometheus instance down long before it takes the app down. Per-tenant
 * questions ("what did workspace X spend?") are LEDGER queries — the
 * ledger exists precisely because per-tenant is a data shape, not a
 * monitoring shape. Labels here are: status CLASS (2xx/4xx/429/5xx),
 * operation, provider, error kind — bounded sets, chosen once.
 *
 * The families:
 *
 * 1. http_requests_total{status_class} — the status-class counter the
 *    heartbeat decision (a+c over b) was made to protect: pre-frame
 *    failures must remain visible as 5xx/4xx, not laundered into 200s.
 *    Counted from an interceptor at the controller boundary.
 *
 * 2. chat_pre_frame_duration_seconds — the bounded pre-frame window, as a
 *    histogram. The 20s deadline's headroom is a number someone should be
 *    able to see, and the WS8 p95 measurements come from exactly here.
 *
 * 3. ledger_write_failures_total — THE PHASE 6 DEFERRED ALERT, now real.
 *    UsageLedger.record swallows its own failures by design ("billing
 *    must never take the product down"); that trade is only honest if a
 *    swallowed failure is VISIBLE. This counter is the visibility. An
 *    alert on rate-of-increase > 0 is the ops response; the metric is the
 *    app's half of the contract.
 *
 * Default process metrics (event loop, GC, memory) ride along: they answer
 * "is it the app or the box" in every incident, and cost one scrape.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  readonly registry = new Registry();

  readonly httpRequestsTotal: Counter<string>;
  readonly chatPreFrameSeconds: Histogram<string>;
  readonly ledgerWriteFailuresTotal: Counter<string>;

  constructor() {
    collectDefaultMetrics({ register: this.registry });

    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'HTTP requests by route and status class. Status CLASS, never raw status: 2xx/4xx/429/5xx are bounded; a per-status label doubles the set for no analytical gain.',
      labelNames: ['route', 'status_class'],
      registers: [this.registry],
    });

    this.chatPreFrameSeconds = new Histogram({
      name: 'chat_pre_frame_duration_seconds',
      help: 'Seconds from request arrival to first SSE frame. The pre-frame deadline bounds this window; the histogram shows how much of the budget is actually used.',
      labelNames: ['outcome'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20],
      registers: [this.registry],
    });

    this.ledgerWriteFailuresTotal = new Counter({
      name: 'ledger_write_failures_total',
      help: 'Failed writes to the per-tenant cost ledger. The ledger swallows failures by design (billing must not take the product down); this counter is what makes that trade-off honest. Alert on any increase.',
      labelNames: ['operation'],
      registers: [this.registry],
    });
  }

  /** Records a request outcome at the controller boundary. */
  recordHttp(route: string, status: number): void {
    const statusClass = status >= 500 ? '5xx' : status === 429 ? '429' : status >= 400 ? '4xx' : '2xx';
    this.httpRequestsTotal.inc({ route, status_class: statusClass });
  }

  /** Pre-frame window observation, from arrival to first frame or failure. */
  observePreFrame(seconds: number, outcome: 'first_frame' | 'failed' | 'deadline'): void {
    this.chatPreFrameSeconds.observe({ outcome }, seconds);
  }

  /**
   * The seam UsageLedger's catch block calls: one increment per swallowed
   * failure. `operation` is bounded (four values) — safe as a label,
   * unlike workspace id.
   */
  recordLedgerWriteFailure(operation: string): void {
    this.ledgerWriteFailuresTotal.inc({ operation });
  }

  /** Prometheus exposition format, for the /metrics endpoint. */
  async render(): Promise<string> {
    return this.registry.metrics();
  }
}