import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { Db } from '../database/database.module';
import { DRIZZLE } from '../database/database.module';
import { memberships, refreshTokens, users, workspaces } from '../database/schema';
import type { Env } from '../config/env.schema';

function scryptAsync(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, { N: 16_384, r: 8, p: 1 }, (error, derived) => {
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
    const existing = await this.db.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail));
    if (existing.length) throw new ConflictException('Email is already registered');
    const passwordHash = await hashPassword(password);
    const result = await this.db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({ email: normalizedEmail, passwordHash }).returning();
      const [workspace] = await tx.insert(workspaces).values({ name: workspaceName.trim() }).returning();
      await tx.insert(memberships).values({ userId: user.id, workspaceId: workspace.id, role: 'owner' });
      return { user, workspace };
    });
    return this.issueSession(result.user.id, result.user.email);
  }

  async login(email: string, password: string) {
    const [user] = await this.db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
    if (!user || !(await verifyPassword(password, user.passwordHash))) throw new UnauthorizedException('Invalid credentials');
    return this.issueSession(user.id, user.email);
  }

  async refresh(rawToken: string) {
    const tokenHash = hashToken(rawToken);
    const [stored] = await this.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
    if (!stored || stored.expiresAt <= new Date()) throw new UnauthorizedException('Refresh token is invalid or expired');
    if (stored.status !== 'active') {
      await this.db.update(refreshTokens).set({ status: 'revoked', revokedAt: new Date() }).where(eq(refreshTokens.familyId, stored.familyId));
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    await this.db.update(refreshTokens).set({ status: 'used', usedAt: new Date() }).where(eq(refreshTokens.id, stored.id));
    const [user] = await this.db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, stored.userId));
    if (!user) throw new UnauthorizedException('User no longer exists');
    return this.issueSession(user.id, user.email, stored.familyId);
  }

  async logout(rawToken: string) {
    await this.db.update(refreshTokens).set({ status: 'revoked', revokedAt: new Date() }).where(eq(refreshTokens.tokenHash, hashToken(rawToken)));
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
    const header = base64Url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const payload = base64Url(Buffer.from(JSON.stringify({ sub: userId, email, iat: now, exp: now + this.accessTtl })));
    const signature = base64Url(createHmac('sha256', this.secret).update(`${header}.${payload}`).digest());
    const refreshToken = randomBytes(48).toString('base64url');
    await this.db.insert(refreshTokens).values({ userId, familyId, tokenHash: hashToken(refreshToken), expiresAt: new Date(Date.now() + this.refreshTtl * 1000) });
    return { accessToken: `${header}.${payload}.${signature}`, refreshToken, expiresIn: this.accessTtl };
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [, saltText, hashText] = encoded.split('$');
  if (!saltText || !hashText) return false;
  const derived = await scryptAsync(password, Buffer.from(saltText, 'base64url'), 64);
  const expected = Buffer.from(hashText, 'base64url');
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function base64Url(value: Buffer): string { return value.toString('base64url'); }