import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { validateEnv, type Env } from '../src/config/env.schema';
import { StorageService } from '../src/ingestion/storage.service';

/**
 * Item [7], part (a), against REAL object storage.
 *
 * `presign-bounded.integration.spec.ts` proves the declared byteSize reaches
 * StorageService, using a storage double. That is the DocumentService →
 * StorageService half. This spec covers the other half — StorageService → S3
 * — which is where the bound is actually created, and which the double
 * necessarily cannot exercise: deleting `ContentLength` from the
 * PutObjectCommand left that suite green.
 *
 * A signed ContentLength is part of the signature, so the client must send
 * exactly that Content-Length. A larger body means a different header, which
 * means a signature that does not verify — storage rejects it before a byte
 * of payload is stored. That is the difference between "bounded" and
 * "checked afterwards", which is what item [7] was about.
 *
 * The happy path is asserted too: a spec that only checks the rejection would
 * also pass if presigning were broken outright.
 */
describe('presigned PUT enforces the signed size (item 7, real storage)', () => {
  const env = validateEnv(process.env as Record<string, unknown>);
  const config = { get: (key: string) => (env as unknown as Record<string, unknown>)[key] } as unknown as ConfigService<Env, true>;
  const storage = new StorageService(config);
  const key = `presign-size-spec/${randomUUID()}.txt`;
  const DECLARED = 64;

  beforeAll(() => {
    // Fail loudly rather than silently skipping: a spec that quietly does not
    // run is the class of defect this whole pass exists to remove.
    if (!process.env.S3_ENDPOINT) throw new Error('S3_ENDPOINT must be set — run pnpm infra:up');
  });

  afterAll(async () => {
    await storage.delete(key).catch(() => undefined);
  });

  it('rejects a body larger than the declared byteSize', async () => {
    const url = await storage.createUploadUrl(key, 'text/plain', DECLARED);
    const response = await fetch(url, { method: 'PUT', body: 'x'.repeat(DECLARED + 1), headers: { 'content-type': 'text/plain' } });

    expect(response.ok, `oversized PUT must be refused, got HTTP ${response.status}`).toBe(false);
    // And nothing landed: the bound is enforced before storage, not after.
    await expect(storage.head(key)).rejects.toThrow();
  });

  it('accepts a body of exactly the declared byteSize', async () => {
    const url = await storage.createUploadUrl(key, 'text/plain', DECLARED);
    const response = await fetch(url, { method: 'PUT', body: 'x'.repeat(DECLARED), headers: { 'content-type': 'text/plain' } });

    expect(response.ok, `exact-size PUT must succeed, got HTTP ${response.status}`).toBe(true);
    expect((await storage.head(key)).size).toBe(DECLARED);
  });
});
