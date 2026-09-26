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
 * Item [7]: presigned uploads must be bounded and metered.
 *
 * Part (a) — ContentLength is a SIGNED header: DocumentService must pass the
 * declared byteSize into the presign, and StorageService must put it on the
 * PutObjectCommand. Previously only Bucket/Key/ContentType were signed, so a
 * client declaring byteSize: 1 could PUT gigabytes; the size check at
 * completeUpload fired after the bytes had landed. The storage double here
 * records what it was asked to sign — if the byteSize stops flowing, this
 * test fails.
 *
 * This covers only the DocumentService -> StorageService half. The other
 * half — StorageService -> S3, where the bound is actually created — is
 * `presign-size-enforced.integration.spec.ts`, which PUTs an oversized body
 * at real MinIO. Both are needed: deleting `ContentLength` from the
 * PutObjectCommand leaves THIS suite green, because the double stands in for
 * the code being tested.
 *
 * Part (b) — the presign route carries a rate-limit window — is covered by
 * `route-guards.integration.spec.ts`, which derives every route from the
 * compiled DI graph and asserts PresignRateLimitGuard on POST /documents.
 * (An earlier version of this comment claimed that coverage before the test
 * existed. It exists now; the claim was the exact code/doc drift this pass
 * was about.)
 */
describe('presigned upload size is signed and bounded (item 7)', () => {
  let owner: Client;
  let pool: Pool;
  let workspaceId: string;
  let documents: DocumentService;
  let presignedWith: Array<{ objectKey: string; contentType: string; contentLength: number | undefined }>;

  const config = { get: (key: string) => ({ MAX_DOCUMENT_BYTES: 25_000_000 })[key] } as unknown as ConfigService<Env, true>;

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    workspaceId = (await owner.query(`insert into workspaces (name) values ('presign-spec') returning id`)).rows[0].id;

    presignedWith = [];
    const storageDouble = {
      createUploadUrl: async (objectKey: string, contentType: string, contentLength: number) => {
        presignedWith.push({ objectKey, contentType, contentLength });
        return 'http://presigned.example';
      },
      delete: async () => undefined,
      head: async () => ({ size: 0 }),
      download: async () => Buffer.from(''),
    } as unknown as StorageService;
    const queue = { add: async () => undefined } as unknown as Queue<IngestDocumentJob>;
    documents = new DocumentService(drizzle(pool, { schema }) as unknown as Db, queue, storageDouble, config);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query(`delete from workspaces where name = 'presign-spec'`);
      await owner.end();
    }
    if (pool) await pool.end();
  });

  it('signs the declared byteSize into the presigned URL', async () => {
    await documents.createUpload({ workspaceId, filename: 'bounded.txt', contentType: 'text/plain', byteSize: 4_096 });
    expect(presignedWith).toHaveLength(1);
    // THE assertion: the size the client declared is the size storage will
    // enforce. Before item [7] the call had no length argument at all.
    expect(presignedWith[0].contentLength).toBe(4_096);
    expect(presignedWith[0].contentType).toBe('text/plain');
  });
});