import { describe, expect, it } from 'vitest';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../src/config/env.schema';
import type { Db } from '../src/database/database.module';
import { AuthService } from '../src/auth/auth.service';
import { WorkspaceMemberGuard } from '../src/auth/auth.guards';
import type { ExecutionContext } from '@nestjs/common';

/**
 * Item [18]: malformed unauthenticated input must be 401/403, never 500.
 *
 * All three of these are reachable by anyone with curl and no credentials.
 * A 500 is worse than the wrong status code: it is an unhandled exception in
 * the auth path, it pages whoever owns the error-rate alert, and it tells the
 * caller they found something the server did not expect.
 */
const SECRET = 'test-secret-value-for-auth-malformed-spec';
const config = {
  get: (key: string) => ({ JWT_ACCESS_SECRET: SECRET, JWT_ACCESS_TTL_SECONDS: 900, REFRESH_TOKEN_TTL_SECONDS: 2_592_000 })[key],
} as unknown as ConfigService<Env, true>;

const auth = new AuthService({} as Db, config);

function signedToken(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', SECRET).update(`${header}.${body}`).digest().toString('base64url');
  return `${header}.${body}.${signature}`;
}

describe('malformed auth input is rejected, not crashed (item 18)', () => {
  it('rejects a signature whose STRING length matches but BYTE length does not', () => {
    // The guard compared string lengths, then Buffer.from() decoded as UTF-8.
    // A 43-character base64url signature is 43 bytes; 43 characters
    // containing one 2-byte character is 44, and timingSafeEqual throws
    // RangeError on unequal buffers — an unauthenticated 500.
    const valid = signedToken({ sub: 'u', email: 'e@x.io', exp: Math.floor(Date.now() / 1000) + 60 });
    const [header, body, signature] = valid.split('.');
    const multiByte = `${'é'}${signature.slice(1)}`;
    expect(multiByte.length).toBe(signature.length);
    expect(Buffer.from(multiByte, 'utf8').length).toBeGreaterThan(Buffer.from(signature, 'utf8').length);

    expect(() => auth.verifyAccessToken(`${header}.${body}.${multiByte}`)).toThrow(UnauthorizedException);
  });

  it('rejects a correctly signed token whose payload is not JSON', () => {
    // Signature verifies, so we reach JSON.parse — which throws SyntaxError
    // on a body that decodes to garbage. Also an unauthenticated 500.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from('this is not json').toString('base64url');
    const signature = createHmac('sha256', SECRET).update(`${header}.${body}`).digest().toString('base64url');

    expect(() => auth.verifyAccessToken(`${header}.${body}.${signature}`)).toThrow(UnauthorizedException);
  });

  it('rejects a non-UUID x-workspace-id before it reaches Postgres', async () => {
    // eq(memberships.workspaceId, 'not-a-uuid') makes Postgres raise 22P02,
    // which surfaces as 500 instead of 403. The db double throws to prove the
    // guard never gets that far.
    const db = { select: () => { throw new Error('query must not run for a malformed workspace id'); } } as unknown as Db;
    const guard = new WorkspaceMemberGuard(db);
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ user: { userId: 'u' }, headers: { 'x-workspace-id': 'not-a-uuid' } }) }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });
});
