import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { ConfigService } from '@nestjs/config';
import * as schema from '../src/database/schema';
import type { Env } from '../src/config/env.schema';
import type { Db } from '../src/database/database.module';
import { UploadSweeperService } from '../src/ingestion/upload-sweeper.service';
import type { StorageService } from '../src/ingestion/storage.service';

/**
 * The sweeper against real Postgres AS THE RUNTIME ROLE — RLS live, since
 * every delete goes through withWorkspace(). Object storage is a double: the
 * behaviour under test is which rows get reclaimed, and MinIO would only add
 * a dependency without adding an assertion.
 */
describe('abandoned upload sweeper (integration)', () => {
  let owner: Client;
  let pool: Pool;
  let db: Db;
  let workspaceId: string;
  let deleted: string[];
  let sweeper: UploadSweeperService;

  const config = { get: (key: string) => ({ ABANDONED_UPLOAD_TTL_HOURS: 24, UPLOAD_SWEEP_INTERVAL_MS: 3_600_000 })[key] } as unknown as ConfigService<Env, true>;

  const makeVersion = async (status: string, ageHours: number, keySuffix: string) => {
    const documentId = (
      await owner.query(`insert into documents (workspace_id, title, status) values ($1, $2, 'pending') returning id`, [workspaceId, `doc-${keySuffix}`])
    ).rows[0].id;
    const versionId = (
      await owner.query(
        `insert into document_versions (document_id, workspace_id, object_key, original_filename, content_type, byte_size, status, created_at)
         values ($1, $2, $3, 'f.txt', 'text/plain', 10, $4, now() - ($5 || ' hours')::interval) returning id`,
        [documentId, workspaceId, `k/${keySuffix}`, status, String(ageHours)],
      )
    ).rows[0].id;
    return { documentId, versionId };
  };

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    db = drizzle(pool, { schema }) as unknown as Db;
    workspaceId = (await owner.query(`insert into workspaces (name) values ('sweeper-spec') returning id`)).rows[0].id;

    deleted = [];
    const storage = { delete: async (key: string) => void deleted.push(key) } as unknown as StorageService;
    sweeper = new UploadSweeperService(db, storage, config);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query(`delete from workspaces where name = 'sweeper-spec'`);
      await owner.end();
    }
    if (pool) await pool.end();
  });

  it('reclaims a pending upload older than the TTL — object and row', async () => {
    const { documentId, versionId } = await makeVersion('pending', 48, 'abandoned');

    const reclaimed = await sweeper.sweep();
    expect(reclaimed).toBeGreaterThanOrEqual(1);
    expect(deleted, 'the storage object must be deleted too, not just the row').toContain('k/abandoned');

    const versions = await owner.query(`select id from document_versions where id = $1`, [versionId]);
    expect(versions.rowCount).toBe(0);
    // Its only version is gone, so the document itself was noise.
    const docs = await owner.query(`select id from documents where id = $1`, [documentId]);
    expect(docs.rowCount).toBe(0);
  });

  it('leaves a pending upload that is still inside the TTL', async () => {
    // The window matters: sweeping too eagerly deletes an upload a slow
    // client is still legitimately completing.
    const { versionId } = await makeVersion('pending', 1, 'recent');
    await sweeper.sweep();
    const rows = await owner.query(`select id from document_versions where id = $1`, [versionId]);
    expect(rows.rowCount).toBe(1);
  });

  it('never touches an upload that completed, however old', async () => {
    // The bug this guards: an age-based S3 lifecycle rule cannot tell these
    // apart from abandoned ones, which is why the sweeper is DB-driven.
    const { documentId, versionId } = await makeVersion('indexed', 500, 'indexed-old');
    await sweeper.sweep();
    expect((await owner.query(`select id from document_versions where id = $1`, [versionId])).rowCount).toBe(1);
    expect((await owner.query(`select id from documents where id = $1`, [documentId])).rowCount).toBe(1);
    expect(deleted, 'a live document object must never be deleted').not.toContain('k/indexed-old');
  });

  it('keeps a document that still has other versions', async () => {
    const { documentId } = await makeVersion('indexed', 500, 'keeper-live');
    const stale = (
      await owner.query(
        `insert into document_versions (document_id, workspace_id, object_key, original_filename, content_type, byte_size, status, created_at)
         values ($1, $2, 'k/keeper-stale', 'f.txt', 'text/plain', 10, 'pending', now() - interval '72 hours') returning id`,
        [documentId, workspaceId],
      )
    ).rows[0].id;

    await sweeper.sweep();

    expect((await owner.query(`select id from document_versions where id = $1`, [stale])).rowCount, 'the abandoned version goes').toBe(0);
    expect((await owner.query(`select id from documents where id = $1`, [documentId])).rowCount, 'but the document stays — it still has a live version').toBe(1);
  });
});
