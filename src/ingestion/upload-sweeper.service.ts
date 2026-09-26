import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { Env } from '../config/env.schema';
import type { Db } from '../database/database.module';
import { DRIZZLE } from '../database/database.module';
import { withWorkspace } from '../database/tenant';
import { documentVersions, workspaces } from '../database/schema';
import { StorageService } from './storage.service';

/**
 * Reclaims uploads that were presigned and never completed.
 *
 * The leak: `createUploadUrl` hands out a presigned PUT and inserts a
 * `pending` version row. If the client never PUTs — closed tab, crashed
 * upload, an abandoned drag-and-drop — the row stays `pending` forever, and
 * if the PUT half-succeeded the object sits in the bucket forever too.
 * Nothing ever looked at those rows again.
 *
 * Why this is a sweeper and not an S3 lifecycle rule: object keys are
 * `workspace/document/version/filename` with no prefix distinguishing
 * pending from completed, so an age-based bucket rule would delete live
 * documents. The database is the only thing that knows which uploads were
 * abandoned. That is a real trade — a bucket rule needs no code and cannot
 * fall behind — and it would become the better answer the day the key layout
 * grows a `pending/` prefix.
 *
 * Runs in the WORKER process only. The API has N replicas and no business
 * doing janitorial work on a request thread; the worker is where scheduled
 * work already lives. With multiple workers the sweeps overlap harmlessly:
 * the delete is idempotent in S3, and the row delete is conditional on the
 * status still being `pending`, so a version that completed mid-sweep is
 * never touched.
 *
 * Failures are logged and swallowed per row. A sweeper that throws takes out
 * the interval and stops reclaiming anything, which is worse than one object
 * it could not delete.
 */
@Injectable()
export class UploadSweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UploadSweeperService.name);
  private readonly ttlHours: number;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlHours = config.get('ABANDONED_UPLOAD_TTL_HOURS', { infer: true });
    this.intervalMs = config.get('UPLOAD_SWEEP_INTERVAL_MS', { infer: true });
  }

  onModuleInit(): void {
    // unref() so an idle sweeper never holds the process open — a worker
    // draining for shutdown should exit, not wait out the interval.
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Returns how many abandoned uploads were reclaimed. Never throws. */
  async sweep(): Promise<number> {
    let reclaimed = 0;
    try {
      const cutoff = new Date(Date.now() - this.ttlHours * 3_600_000);
      // There is no cross-tenant read to be had, and that is the system
      // working: `document_versions` has RLS FORCED, so a query without
      // `app.workspace_id` set returns zero rows — silently. The first
      // version of this sweeper did exactly that and reclaimed nothing while
      // reporting success. So it enumerates tenants first (`workspaces` is
      // not workspace-keyed and carries no policy) and sweeps each one INSIDE
      // its own withWorkspace() transaction. Slower than one scan; the only
      // shape that can actually see the rows.
      const tenants = await this.db.select({ id: workspaces.id }).from(workspaces);

      const stale: Array<{ id: string; workspaceId: string; documentId: string; objectKey: string }> = [];
      for (const tenant of tenants) {
        const rows = await withWorkspace(this.db, tenant.id, async (tx) =>
          tx
            .select({ id: documentVersions.id, workspaceId: documentVersions.workspaceId, documentId: documentVersions.documentId, objectKey: documentVersions.objectKey })
            .from(documentVersions)
            .where(and(eq(documentVersions.status, 'pending'), lt(documentVersions.createdAt, cutoff)))
            .limit(500),
        );
        stale.push(...rows);
      }

      for (const row of stale) {
        try {
          await this.storage.delete(row.objectKey);
          await withWorkspace(this.db, row.workspaceId, async (tx) => {
            // Conditional on status: a client that completed the upload
            // between the SELECT and here must not lose its document.
            const deleted = await tx
              .delete(documentVersions)
              .where(and(eq(documentVersions.id, row.id), eq(documentVersions.workspaceId, row.workspaceId), eq(documentVersions.status, 'pending')))
              .returning({ id: documentVersions.id });
            if (deleted.length === 0) return;
            // A document whose only version was abandoned is itself noise.
            await tx.execute(sql`
              delete from documents
              where id = ${row.documentId}::uuid
                and workspace_id = ${row.workspaceId}::uuid
                and not exists (select 1 from ${documentVersions} v where v.document_id = ${row.documentId}::uuid)
            `);
            reclaimed += 1;
          });
        } catch (error) {
          this.logger.warn(`could not reclaim abandoned upload ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (reclaimed > 0) this.logger.log(`reclaimed ${reclaimed} abandoned upload(s) older than ${this.ttlHours}h`);
    } catch (error) {
      this.logger.warn(`upload sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return reclaimed;
  }
}
