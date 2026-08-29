import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Inject } from '@nestjs/common';
import { and, eq, gt } from 'drizzle-orm';
import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { Db } from '../database/database.module';
import { DRIZZLE } from '../database/database.module';
import { memberships, refreshTokens, users, workspaces } from '../database/schema';
import { isUniqueViolation } from '../database/errors';
import type { Env } from '../config/env.schema';
import { ACCESS_TOKEN_ALGORITHM, ACCESS_TOKEN_TYPE, PASSWORD_HASH_ALGORITHM, PASSWORD_KEY_LENGTH, PASSWORD_SALT_BYTES, PASSWORD_SCRYPT_OPTIONS, REFRESH_TOKEN_BYTES } from './auth.constants';

/**
 * A structurally valid hash that no password can match, used to keep the
 * failure path of `login` the same cost as the success path.
 */
const DUMMY_PASSWORD_HASH = `${PASSWORD_HASH_ALGORITHM}$${randomBytes(PASSWORD_SALT_BYTES).toString('base64url')}$${randomBytes(PASSWORD_KEY_LENGTH).toString('base64url')}`;

function scryptAsync(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, PASSWORD_SCRYPT_OPTIONS, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}

@Injectable()
export class AuthService {
  private readonly secret: string;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;

  constructor(@Inject(DRIZZLE) private readonly db: Db, config: ConfigService<Env, true>) {
    this.secret = config.get('JWT_ACCESS_SECRET', { infer: true });
    this.accessTtl = config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
    this.refreshTtl = config.get('REFRESH_TOKEN_TTL_SECONDS', { infer: true });
  }

  async register(email: string, password: string, workspaceName: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const passwordHash = await hashPassword(password);
    try {
      // No pre-flight SELECT: the unique index on users.email is the only
      // check that cannot be raced, so let it be the one that decides.
      const result = await this.db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ email: normalizedEmail, passwordHash }).returning();
        const [workspace] = await tx.insert(workspaces).values({ name: workspaceName.trim() }).returning();
        await tx.insert(memberships).values({ userId: user.id, workspaceId: workspace.id, role: 'owner' });
        return { user, workspace };
      });
      return await this.issueSession(result.user.id, result.user.email);
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_idx')) throw new ConflictException('Email is already registered');
      throw error;
    }
  }

  async login(email: string, password: string) {
    const [user] = await this.db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
    // Always pay the scrypt cost, even when the address is unknown. Returning
    // early would make "no such user" measurably faster than "wrong password",
    // which is a free account-enumeration oracle for anyone with a stopwatch.
    const matches = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !matches) throw new UnauthorizedException('Invalid credentials');
    return this.issueSession(user.id, user.email);
  }

  /**
   * Rotates a refresh token. The claim is a single conditional UPDATE rather
   * than SELECT-then-UPDATE: two concurrent requests carrying the same token
   * would both pass a read-side `status === 'active'` check and both be issued
   * a session, which is exactly the reuse the family design exists to catch.
   * Postgres serialises the UPDATE, so precisely one caller gets a row back.
   */
  async refresh(rawToken: string) {
    const tokenHash = hashToken(rawToken);
    const now = new Date();
    const [claimed] = await this.db
      .update(refreshTokens)
      .set({ status: 'used', usedAt: now })
      .where(and(eq(refreshTokens.tokenHash, tokenHash), eq(refreshTokens.status, 'active'), gt(refreshTokens.expiresAt, now)))
      .returning();
    if (!claimed) {
      const [existing] = await this.db.select({ familyId: refreshTokens.familyId, status: refreshTokens.status }).from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
      // A token we have seen before but can no longer claim was already spent:
      // the holder is replaying it, so burn the whole family.
      if (existing && existing.status !== 'active') {
        await this.revokeFamily(existing.familyId, now);
        throw new UnauthorizedException('Refresh token reuse detected');
      }
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }
    const [user] = await this.db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, claimed.userId));
    if (!user) throw new UnauthorizedException('User no longer exists');
    return this.issueSession(user.id, user.email, claimed.familyId);
  }

  /** Logging out ends the session chain, not just the one token presented. */
  async logout(rawToken: string) {
    const now = new Date();
    const [stored] = await this.db.select({ familyId: refreshTokens.familyId }).from(refreshTokens).where(eq(refreshTokens.tokenHash, hashToken(rawToken)));
    if (stored) await this.revokeFamily(stored.familyId, now);
  }

  private async revokeFamily(familyId: string, at: Date) {
    await this.db.update(refreshTokens).set({ status: 'revoked', revokedAt: at }).where(and(eq(refreshTokens.familyId, familyId), eq(refreshTokens.status, 'active')));
  }

  verifyAccessToken(token: string): { userId: string; email: string } {
    const [encodedHeader, encodedPayload, signature] = token.split('.');
    if (!encodedHeader || !encodedPayload || !signature) throw new UnauthorizedException('Invalid access token');
    const expected = base64Url(createHmac('sha256', this.secret).update(`${encodedHeader}.${encodedPayload}`).digest());
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new UnauthorizedException('Invalid access token');
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()) as { sub?: string; email?: string; exp?: number };
    if (!payload.sub || !payload.email || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new UnauthorizedException('Access token expired');
    return { userId: payload.sub, email: payload.email };
  }

  private async issueSession(userId: string, email: string, familyId: string = randomUUID()) {
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(Buffer.from(JSON.stringify({ alg: ACCESS_TOKEN_ALGORITHM, typ: ACCESS_TOKEN_TYPE })));
    const payload = base64Url(Buffer.from(JSON.stringify({ sub: userId, email, iat: now, exp: now + this.accessTtl })));
    const signature = base64Url(createHmac('sha256', this.secret).update(`${header}.${payload}`).digest());
    const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    await this.db.insert(refreshTokens).values({ userId, familyId, tokenHash: hashToken(refreshToken), expiresAt: new Date(Date.now() + this.refreshTtl * 1000) });
    return { accessToken: `${header}.${payload}.${signature}`, refreshToken, expiresIn: this.accessTtl };
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const derived = await scryptAsync(password, salt, PASSWORD_KEY_LENGTH);
  return `${PASSWORD_HASH_ALGORITHM}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [, saltText, hashText] = encoded.split('$');
  if (!saltText || !hashText) return false;
  const derived = await scryptAsync(password, Buffer.from(saltText, 'base64url'), PASSWORD_KEY_LENGTH);
  const expected = Buffer.from(hashText, 'base64url');
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function base64Url(value: Buffer): string { return value.toString('base64url'); }