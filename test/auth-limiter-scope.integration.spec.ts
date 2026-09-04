import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { ExecutionContext } from '@nestjs/common';
import { RateLimiterService } from '../src/rate-limit/rate-limiter.service';
import { LoginRateLimitGuard, RegisterRateLimitGuard } from '../src/auth/login-rate-limit.guard';

/**
 * Item [17]: /auth/register and /auth/login must not share a rate-limit key.
 *
 * Both routes used LoginRateLimitGuard, which consumes
 * `rl:login:email:${email}`. So anyone who knew a victim's address could POST
 * /auth/register ten times and lock that victim out of LOGIN for the rest of
 * the window — a targeted account-availability denial costing ten
 * unauthenticated requests, no credentials and no account required.
 *
 * The per-email window is a good control. Sharing it across two endpoints
 * with different threat profiles is what broke it.
 */
describe('register and login have independent limiter windows (item 17)', () => {
  let redis: Redis;
  let limiter: RateLimiterService;
  let register: RegisterRateLimitGuard;
  let login: LoginRateLimitGuard;
  const email = `victim-${randomUUID()}@example.test`;
  const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;

  const contextFor = (address: string) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ ip: address, body: { email } }) }) }) as unknown as ExecutionContext;

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    limiter = new RateLimiterService(redis);
    register = new RegisterRateLimitGuard(limiter);
    login = new LoginRateLimitGuard(limiter);
  });

  afterAll(async () => {
    await redis?.del(`rl:register:email:${email}`, `rl:login:email:${email}`, `rl:register:ip:${ip}`, `rl:login:ip:${ip}`).catch(() => undefined);
    await redis?.quit();
  });

  it('exhausting the register window does not lock the same email out of login', async () => {
    // Burn the per-email register window (limit 10 per 300s).
    for (let attempt = 0; attempt < 10; attempt++) {
      await expect(register.canActivate(contextFor(ip))).resolves.toBe(true);
    }
    await expect(register.canActivate(contextFor(ip)), 'the 11th register must be refused').rejects.toThrow(/Too many attempts/);

    // THE assertion: the victim can still log in. Before item [17] this threw,
    // because both guards consumed rl:login:email:<email>.
    await expect(login.canActivate(contextFor(ip)), 'login must be unaffected by register attempts').resolves.toBe(true);
  });
});
