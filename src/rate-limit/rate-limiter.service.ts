import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module';

/**
 * Distributed rate limiting over Redis. Three shapes, one rule:
 *
 * RULE: every limiter state transition is ONE atomic Redis operation or ONE
 * Lua script. A limit checked in one round-trip and enforced in a second is
 * two requests racing between them — under concurrency the "limit" is a
 * suggestion. Hand-rolled limiters fail in exactly this way, and
 * INCR-then-EXPIRE as separate commands additionally leaves a window where
 * a process crash strands a key with no TTL, locking a tenant out forever.
 * So: all three scripts are EVAL'd as single atomic units.
 *
 * (1) FIXED WINDOW (request counts): login, register, search, upload.
 *     The window script INCRs and sets TTL only on the first increment —
 *     no separate EXPIRE, no TTL-less key, ever.
 *
 * (2) STREAM-START WINDOW: chat requests per workspace per window. Same
 *     atomic shape as (1); a chat request holds a connection for ~30s, so
 *     the window protects starts, not tokens.
 *
 * (3) CONCURRENT-STREAM LEASE (ZSET): how many streams a workspace may
 *     hold OPEN at once. An INCR/DECR pair can never self-heal — a process
 *     killed mid-stream leaks the slot until a human notices. The lease is
 *     a sorted set of {stream id -> expiry timestamp}: each check prunes
 *     expired members (ZREMRANGEBYSCORE), then ZCARDs and ZADDs in ONE
 *     script — so a crashed process's leases free themselves at their
 *     expiry, and the cap holds under concurrent attempts because admit
 *     and register are the same atomic step.
 */
@Injectable()
export class RateLimiterService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Atomic fixed window. Returns true if the request is admitted.
   * KEYS[1] = window counter; ARGV[1] = limit; ARGV[2] = window seconds;
   * ARGV[3] = now-seconds (for the deterministic test clock, if provided).
   *
   * The TTL is set on the FIRST increment only, inside the same script —
   * a later EXPIRE is what creates the stranded-key lockout window.
   */
  private static readonly WINDOW_SCRIPT = `
    local current = redis.call('INCR', KEYS[1])
    if current == 1 then
      redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 1000)
    end
    return current
  `;

  /**
   * Atomic stream lease. KEYS[1] = lease ZSET; ARGV[1] = stream id;
   * ARGV[2] = limit; ARGV[3] = lease TTL ms (leases expire even if the
   * process dies mid-stream — that self-healing is the whole point);
   * ARGV[4] = now-ms.
   *
   * Each member's SCORE is its own expiry (acquired_at + its TTL), so
   * pruning is "remove scores at or below now" — NOT "now minus the current
   * request's TTL", which under-prunes leases acquired with a shorter TTL
   * than the incoming one (caught by the self-heal test). Prune, count,
   * admit+register in one unit: two concurrent attempts can never both see
   * "3 of 3 free".
   */
  private static readonly LEASE_SCRIPT = `
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[4])
    local count = redis.call('ZCARD', KEYS[1])
    if count >= tonumber(ARGV[2]) then
      return 0
    end
    redis.call('ZADD', KEYS[1], ARGV[4] + ARGV[3], ARGV[1])
    return 1
  `;

  /** Fixed-window check+consume. Returns whether the request is admitted. */
  async consume(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const current = (await this.redis.eval(RateLimiterService.WINDOW_SCRIPT, 1, key, limit, windowSeconds)) as number;
    return current <= limit;
  }

  /** Acquires a concurrent-stream lease; release() frees it early. */
  async acquireLease(key: string, streamId: string, limit: number, leaseTtlMs: number): Promise<boolean> {
    const now = Date.now();
    const admitted = (await this.redis.eval(RateLimiterService.LEASE_SCRIPT, 1, key, streamId, limit, leaseTtlMs, now)) as number;
    return admitted === 1;
  }

  /** Early release for a cleanly-ended stream (crash cleanliness needs no help). */
  async releaseLease(key: string, streamId: string): Promise<void> {
    await this.redis.zrem(key, streamId);
  }

  /**
   * Login limiters are keyed on BOTH the source IP and the submitted email,
   * separately. Pre-auth there is no workspace and no user id — IP is the
   * attacker-controlled pivot for credential stuffing from one host, and
   * email is the pivot for password spraying across hosts. Either check
   * failing denies the request, and both windows reset independently.
   */
  async checkLogin(ip: string, email: string, ipLimit: number, ipWindowSeconds: number, emailLimit: number, emailWindowSeconds: number): Promise<boolean> {
    const [byIp, byEmail] = await Promise.all([
      this.consume(`rl:login:ip:${ip}`, ipLimit, ipWindowSeconds),
      this.consume(`rl:login:email:${email}`, emailLimit, emailWindowSeconds),
    ]);
    return byIp && byEmail;
  }
}