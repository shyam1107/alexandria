import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { RateLimiterService } from '../src/rate-limit/rate-limiter.service';

/**
 * Phase 7 rate limiting, tested the only way a limiter can be tested:
 * EXCEEDING it, against REAL Redis, with CONCURRENT requests.
 *
 * Asserting a config value proves nothing about the limiter; asserting that
 * the 21st request in a 20-limit window is denied proves the script ran. And
 * asserting under concurrency — 50 requests racing a limit of 20 — proves
 * the atomicity claim: if check and consume were separate round-trips, more
 * than 20 would be admitted. That is the exact failure mode of a
 * hand-rolled INCR-then-check limiter and of any limiter that reads state
 * in one op and writes it in another.
 *
 * The TTL invariant gets its own test: a limiter key with no TTL strands a
 * tenant out forever (INCR without EXPIRE, or EXPIRE lost to a crash between
 * the two commands). The window script sets TTL inside the same atomic unit
 * as the first increment, so there is no window where the key exists
 * un-expiring.
 */

describe('rate limiter (integration, real Redis)', () => {
  let redis: Redis;
  let limiter: RateLimiterService;

  beforeAll(async () => {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL must be set. Copy .env.example to .env.');
    redis = new Redis(url);
    limiter = new RateLimiterService(redis);
  });

  afterAll(async () => {
    if (redis) await redis.quit();
  });

  it('admits exactly the limit and denies the rest of the window', async () => {
    const key = `rl-test:window:${randomUUID()}`;
    // Warm-up: the first request creates the key WITH its TTL (that is part
    // of the contract under test, so it is consumed by the first request).
    expect(await limiter.consume(key, 3, 60)).toBe(true);
    expect(await limiter.consume(key, 3, 60)).toBe(true);
    expect(await limiter.consume(key, 3, 60)).toBe(true);
    expect(await limiter.consume(key, 3, 60)).toBe(false);
    expect(await limiter.consume(key, 3, 60)).toBe(false);
  });

  it('never exceeds the limit under concurrency (atomicity of check+consume)', async () => {
    const key = `rl-test:race:${randomUUID()}`;
    const limit = 20;
    // 50 concurrent attempts racing a 20-slot window. If the INCR and the
    // limit decision were separate operations, races would admit >20.
    const results = await Promise.all(Array.from({ length: 50 }, () => limiter.consume(key, limit, 60)));
    const admitted = results.filter(Boolean).length;
    expect(admitted).toBe(limit);
    // And the key has its TTL from the very first increment — no
    // TTL-less stranded key, ever.
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
  });

  it('expires the window and admits again (the lockout is bounded)', async () => {
    const key = `rl-test:expiry:${randomUUID()}`;
    expect(await limiter.consume(key, 1, 1)).toBe(true);
    expect(await limiter.consume(key, 1, 1)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await limiter.consume(key, 1, 1)).toBe(true);
  });

  it('caps concurrent stream leases — and the cap holds under a concurrent rush', async () => {
    const key = `rl-test:lease:${randomUUID()}`;
    const limit = 5;
    // 20 concurrent lease attempts: at most 5 may hold; the rest are denied
    // in the same atomic script that counts, so no overadmission is possible.
    const results = await Promise.all(Array.from({ length: 20 }, () => limiter.acquireLease(key, randomUUID(), limit, 60_000)));
    expect(results.filter(Boolean).length).toBe(limit);
  });

  it('self-heals: an expired lease frees its slot without any release call', async () => {
    const key = `rl-test:heal:${randomUUID()}`;
    const expiredId = randomUUID();
    // A 150ms lease, never released — the crashed-process case. While it is
    // live the slot is held; after expiry the acquire script prunes it.
    expect(await limiter.acquireLease(key, expiredId, 1, 150)).toBe(true);
    expect(await limiter.acquireLease(key, randomUUID(), 1, 60_000)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 250));
    // No releaseLease was ever called: the expired lease pruned itself
    // inside the acquire script and the slot is free again.
    expect(await limiter.acquireLease(key, randomUUID(), 1, 60_000)).toBe(true);
  });

  it('releases a lease early, and only its own', async () => {
    const key = `rl-test:release:${randomUUID()}`;
    const mine = randomUUID();
    expect(await limiter.acquireLease(key, mine, 1, 60_000)).toBe(true);
    // Releasing a foreign id frees nothing.
    await limiter.releaseLease(key, randomUUID());
    expect(await limiter.acquireLease(key, randomUUID(), 1, 60_000)).toBe(false);
    // Releasing my id frees the slot.
    await limiter.releaseLease(key, mine);
    expect(await limiter.acquireLease(key, randomUUID(), 1, 60_000)).toBe(true);
  });

  it('limits login by BOTH ip and email — either window denying is enough', async () => {
    const email = `spray-${randomUUID()}@test.local`;
    // Email window: 10 per 300s. Same email from DIFFERENT IPs (password
    // spraying): the email window must deny on the 11th attempt even though
    // every IP window is fresh.
    const ips = Array.from({ length: 15 }, (_, i) => `10.1.${i}.${(i % 250) + 1}`);
    const results: boolean[] = [];
    for (const sprayIp of ips) {
      results.push(await limiter.checkLogin(sprayIp, email, 20, 300, 10, 300));
    }
    expect(results.filter(Boolean).length).toBe(10);

    // IP window: 20 per 300s. Same IP, DIFFERENT emails (credential
    // stuffing from one host): the IP window must deny past 20 even though
    // every email window is fresh.
    const stuffIp = `10.9.0.${Math.floor(Math.random() * 250) + 1}`;
    const emails = Array.from({ length: 25 }, (_, i) => `victim${i}-${randomUUID()}@test.local`);
    const stuffResults: boolean[] = [];
    for (const victim of emails) {
      stuffResults.push(await limiter.checkLogin(stuffIp, victim, 20, 300, 10, 300));
    }
    expect(stuffResults.filter(Boolean).length).toBe(20);
  });
});