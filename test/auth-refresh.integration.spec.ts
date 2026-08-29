import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import * as schema from '../src/database/schema';
import type { Db } from '../src/database/database.module';
import type { Env } from '../src/config/env.schema';
import { AuthService } from '../src/auth/auth.service';

/**
 * Refresh-token rotation is only worth having if replaying a spent token is
 * detectable. The original implementation read the token, checked that it was
 * active, then marked it used in a second statement — so two requests carrying
 * the same stolen token could both pass the check and both be issued a session,
 * and the reuse that the token-family design exists to catch would go
 * unnoticed. These tests pin the atomic version down.
 */

const settings: Partial<Env> = {
  JWT_ACCESS_SECRET: 'test-secret-that-is-at-least-32-characters-long',
  JWT_ACCESS_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 2_592_000,
};

const config = { get: (key: keyof Env) => settings[key] } as unknown as ConfigService<Env, true>;

describe('refresh token rotation', () => {
  let pool: Pool;
  let db: Db;
  let auth: AuthService;
  const createdEmails: string[] = [];

  async function newUser() {
    const email = `rotation-${randomUUID()}@example.test`;
    createdEmails.push(email);
    return { email, session: await auth.register(email, 'correct-horse-battery-staple', 'Rotation Spec') };
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set. Copy .env.example to .env.');
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });
    auth = new AuthService(db, config);
  });

  afterAll(async () => {
    if (!pool) return;
    // refresh_tokens and memberships cascade from users; workspaces do not.
    await pool.query(`delete from workspaces where name = 'Rotation Spec'`);
    await pool.query(`delete from users where email = any($1::text[])`, [createdEmails]);
    await pool.end();
  });

  it('issues a new pair and retires the presented token', async () => {
    const { session } = await newUser();
    const rotated = await auth.refresh(session.refreshToken);

    expect(rotated.refreshToken).not.toBe(session.refreshToken);
    expect(rotated.accessToken).toBeTruthy();
    // The new token works...
    await expect(auth.refresh(rotated.refreshToken)).resolves.toBeTruthy();
  });

  it('lets exactly one of two concurrent requests claim the same token', async () => {
    const { session } = await newUser();

    // The regression test for the read-then-write race. Both requests race the
    // same row; Postgres serialises the conditional UPDATE, so the loser sees
    // zero rows updated rather than a stale 'active' read.
    const outcomes = await Promise.allSettled([auth.refresh(session.refreshToken), auth.refresh(session.refreshToken)]);
    const winners = outcomes.filter((o) => o.status === 'fulfilled');
    const losers = outcomes.filter((o) => o.status === 'rejected');

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
  });

  it('burns the whole family when a spent token is replayed', async () => {
    const { session } = await newUser();
    const rotated = await auth.refresh(session.refreshToken);

    // An attacker replays the token the legitimate client already spent.
    await expect(auth.refresh(session.refreshToken)).rejects.toThrow(/reuse detected/i);

    // The legitimate client's current token must die with it — otherwise
    // detection is a log line rather than a defence.
    await expect(auth.refresh(rotated.refreshToken)).rejects.toThrow();
  });

  it('rejects an unknown token without reporting reuse', async () => {
    await expect(auth.refresh('not-a-real-token')).rejects.toThrow(/invalid or expired/i);
  });

  it('ends the session chain on logout', async () => {
    const { session } = await newUser();
    await auth.logout(session.refreshToken);
    await expect(auth.refresh(session.refreshToken)).rejects.toThrow();
  });
});
