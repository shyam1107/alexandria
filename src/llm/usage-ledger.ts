import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Db } from '../database/database.module';
import { DRIZZLE } from '../database/database.module';
import { withWorkspace } from '../database/tenant';
import { llmUsageEvents } from '../database/schema';
import { computeCostMicroUsd } from './pricing';

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
 * Two rules define the class:
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
 */
@Injectable()
export class UsageLedger {
  private readonly logger = new Logger(UsageLedger.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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
    } catch (error) {
      this.logger.warn(`Failed to write usage ledger row: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
