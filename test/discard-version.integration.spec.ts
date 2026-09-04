import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { ConfigService } from '@nestjs/config';
import * as schema from '../src/database/schema';
import type { Env } from '../src/config/env.schema';
import type { Db } from '../src/database/database.module';
import { DocumentService } from '../src/ingestion/document.service';
import type { StorageService } from '../src/ingestion/storage.service';
import type { Queue } from 'bullmq';
import type { IngestDocumentJob } from '../src/ingestion/ingestion.constants';

/**
 * Item [8]: `discardVersion` must reclaim the S3 object, not just the rows.
 *
 * The leak: the Phase 7b sweeper only finds rows with status = 'pending',
 * and discardVersion DELETES the row — so nothing ever references the
 * object again and nothing reclaims it. The old comment deferred to a bucket
 * lifecycle rule that Phase 7b explicitly rejected (object keys carry no
 * pending/completed prefix; an age-based rule deletes live documents).
 *
 * Object storage is a double (same call as the sweeper spec): the behaviour
 * under test is that delete() is CALLED with the version's key. Real Postgres
 * as the runtime role, RLS live.
 */
describe('discardVersion reclaims its S3 object (item 8)', () => {
  let owner: Client;
  let pool: Pool;
  let workspaceId: string;
  let deleted: string[];
  let documents: DocumentService;

  const config = { get: (key: string) => ({ MAX_DOCUMENT_BYTES: 25_000_000 })[key] } as unknown as ConfigService<Env, true>;

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    workspaceId = (await owner.query(`insert into workspaces (name) values ('discard-spec') returning id`)).rows[0].id;

    deleted = [];
    const storageDouble = {
      delete: async (key: string) => void deleted.push(key),
      head: async () => ({ size: 5 }),
      download: async () => Buffer.from('hello'),
      createUploadUrl: async () => 'http://presigned.example',
    } as unknown as StorageService;
    const queue = { add: async () => undefined } as unknown as Queue<IngestDocumentJob>;
    documents = new DocumentService(drizzle(pool, { schema }) as unknown as Db, queue, storageDouble, config);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query(`delete from workspaces where name = 'discard-spec'`);
      await owner.end();
    }
    if (pool) await pool.end();
  });

  it('a duplicate-content completeUpload deletes the redundant version and its object', async () => {
    // First upload: the original that will win. Storage is a double serving
    // identical bytes to both versions, so the second hashes the same.
    const original = await documents.createUpload({ workspaceId, filename: 'original.txt', contentType: 'text/plain', byteSize: 5 });
    await documents.completeUpload(workspaceId, original.document.id, original.versionId).catch(() => undefined);

    // Second upload: same bytes => duplicate contentHash => discardVersion.
    const duplicate = await documents.createUpload({ workspaceId, filename: 'duplicate.txt', contentType: 'text/plain', byteSize: 5 });
    await expect(documents.completeUpload(workspaceId, duplicate.document.id, duplicate.versionId)).rejects.toThrow(/Identical content/);

    // THE ASSERTION: the discarded version's object was deleted from storage,
    // not just the rows. Before item [8] this key was leaked forever.
    expect(deleted, 'discardVersion must reclaim the redundant S3 object').toContain(duplicate.objectKey);

    // And the rows are gone too — the pre-existing behaviour.
    const versions = await owner.query(`select id from document_versions where id = $1`, [duplicate.versionId]);
    expect(versions.rowCount).toBe(0);
    const docs = await owner.query(`select id from documents where id = $1`, [duplicate.document.id]);
    expect(docs.rowCount).toBe(0);
  });
});