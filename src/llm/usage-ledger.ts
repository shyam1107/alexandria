import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Db } from '../database/database.module';
import { DRIZZLE } from '../database/database.module';
import { withWorkspace } from '../database/tenant';
import { llmUsageEvents } from '../database/schema';
import { computeCostMicroUsd } from './pricing';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { QUOTA_MONTHLY_MICRO_USD } from './quota.constants';
import type { MetricsService } from '../metrics/metrics.service';

export interface UsageEntry {
  operation: 'chat_answer' | 'query_rewrite' | 'embedding_index' | 'embedding_query';
  provider?: string | null;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  success: boolean;
  errorKind?: 'provider_error' | 'timeout' | 'client_disconnect' | 'prompt_blocked' | null;
  messageId?: string | null;
}

/**
 * The per-tenant cost ledger. Every provider call of every kind writes one
 * append-only row — the answer call is not even the majority of LLM spend
 * (rewrites and per-chunk embeddings had nowhere to hang off `messages`).
 *
 * Three rules define the class:
 *
 * 1. Billing must never take the product down. `record` swallows and logs
 *    its own failures — callers can safely await it in the hot path. The
 *    trade-off is real (a broken ledger fails silently for whoever isn't
 *    reading logs) and accepted: Phase 7's metrics/alerts are the fix, not
 *    request-path coupling.
 *
 * 2. Every write goes through withWorkspace() — the ingestion worker writes
 *    rows outside any HTTP request, connects as alexandria_app, and is
 *    subject to forced RLS like everyone else.
 *
 * 3. Phase 7: the same write ALSO increments the workspace's monthly Redis
 *    quota counter — the single choke point where cost is computed, so the
 *    counter and the ledger increment together (a quota based on "records
 *    written" that drifts from "money spent" is a billing dispute in
 *    waiting). The counter is a fast-path approximation: the ledger row
 *    remains the source of truth; a Redis flush loses the counter, and the
 *    month's cap becomes "what has been re-recorded since" — bounded
 *    exposure, deliberately, because the alternative (SUM over an
 *    append-only table on every request) is a growing scan on the hot path.
 *    A scheduled reconcile job belongs in Phase 9 ops.
 */
@Injectable()
export class UsageLedger {
  private readonly logger = new Logger(UsageLedger.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    // Optional so test harnesses can construct the ledger with just a db
    // double; production wiring always has MetricsModule (global).
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /** Counter key: monthly budget window, calendar month, per workspace. */
  private quotaKey(workspaceId: string): string {
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    return `quota:${workspaceId}:${month}`;
  }

  async record(workspaceId: string, entry: UsageEntry): Promise<void> {
    try {
      const costMicroUsd = computeCostMicroUsd(
        entry.provider ?? null,
        entry.model ?? null,
        entry.promptTokens ?? null,
        entry.completionTokens ?? null,
      );
      await withWorkspace(this.db, workspaceId, async (tx) => {
        await tx.insert(llmUsageEvents).values({
          workspaceId,
          operation: entry.operation,
          provider: entry.provider ?? null,
          model: entry.model ?? null,
          promptTokens: entry.promptTokens ?? null,
          completionTokens: entry.completionTokens ?? null,
          costMicroUsd,
          success: entry.success,
          errorKind: entry.errorKind ?? null,
          messageId: entry.messageId ?? null,
        });
      });
      // Fast-path counter. Only SUCCESSFUL calls consume quota: failures
      // (provider_error, timeout) produced no value and a retried call
      // would double-bill. Client disconnects DID consume the tokens, so
      // they count — the provider charges us regardless of delivery.
      if (costMicroUsd !== null && (entry.success || entry.errorKind === 'client_disconnect')) {
        await this.redis
          .multi()
          .incrby(this.quotaKey(workspaceId), Number(costMicroUsd))
          .expire(this.quotaKey(workspaceId), 60 * 60 * 24 * 45) // ~1.5 months: this month + reconcile window
          .exec()
          .catch(() => undefined /* counter failure must not fail the ledger row */);
      }
    } catch (error) {
      // Rule 1: never take the product down. The Phase 6 deferred alert is
      // now real: the swallowed failure increments
      // ledger_write_failures_total, so "billing can't take the product
      // down" stops meaning "billing fails invisibly".
      this.logger.warn(`Failed to write usage ledger row: ${error instanceof Error ? error.message : String(error)}`);
      this.metrics?.recordLedgerWriteFailure(entry.operation);
    }
  }

  /**
   * Consumption so far this month, for the pre-frame check. Returns 0 when
   * the counter is absent (fresh month / Redis flushed) — the bounded-loss
   * trade-off documented on the class.
   */
  async consumedSoFar(workspaceId: string): Promise<number> {
    const value = await this.redis.get(this.quotaKey(workspaceId)).catch(() => null);
    return value === null ? 0 : Number(value);
  }

  /**
   * Whether the workspace may spend more. The check runs BEFORE the first
   * frame; overshoot is bounded by one request's spend (the check is
   * consumption-so-far, and cost is known only after a call finishes).
   */
  async withinBudget(workspaceId: string): Promise<boolean> {
    const consumed = await this.consumedSoFar(workspaceId);
    return consumed < QUOTA_MONTHLY_MICRO_USD;
  }
}