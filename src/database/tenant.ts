import { sql } from 'drizzle-orm';
import type { Db } from './database.module';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Runs `work` inside a transaction that has declared which tenant it acts for.
 *
 * `set_config(..., true)` is *transaction-local*: the setting is discarded on
 * COMMIT/ROLLBACK. That is what makes this safe on a pooled connection — the
 * next checkout of the same physical socket can never inherit a previous
 * request's workspace.
 *
 * Row Level Security policies read `app.workspace_id`. When it is unset,
 * `current_setting('app.workspace_id', true)` is NULL and every policy
 * predicate evaluates to NULL — so a query that skips this helper sees zero
 * rows rather than everyone's rows. It fails closed.
 */
export async function withWorkspace<T>(db: Db, workspaceId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    return work(tx);
  });
}
