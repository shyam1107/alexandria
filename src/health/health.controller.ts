import { Controller, Get, Inject, VERSION_NEUTRAL } from '@nestjs/common';
import { HealthCheck, HealthCheckService, HealthIndicatorService } from '@nestjs/terminus';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { REDIS } from '../redis/redis.module';

/**
 * Two endpoints, two questions:
 *  - /health/live  — "is the process itself alive?" (no dependencies).
 *    Orchestrators use this to decide whether to RESTART the container.
 *  - /health/ready — "can this instance serve traffic?" (checks deps).
 *    Load balancers use this to decide whether to SEND TRAFFIC.
 *
 * Conflating them causes a classic outage: DB blips → liveness fails →
 * every container restarts simultaneously → thundering herd on recovery.
 */
// VERSION_NEUTRAL: liveness/readiness URLs are wired into load balancers and
// orchestrator manifests — they must never move when the API version bumps.
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => this.checkPostgres(), () => this.checkRedis()]);
  }

  private async checkPostgres(): Promise<HealthIndicatorResult> {
    const check = this.indicator.check('postgres');
    try {
      await withTimeout(this.pool.query('SELECT 1'), 2_000, 'postgres');
      return check.up();
    } catch (error) {
      return check.down({ message: (error as Error).message });
    }
  }

  private async checkRedis(): Promise<HealthIndicatorResult> {
    const check = this.indicator.check('redis');
    try {
      // ioredis runs with maxRetriesPerRequest: null (BullMQ requirement),
      // so a bare ping() RETRIES FOREVER while Redis is down. Without this
      // deadline, /health/ready hangs instead of returning 503 — discovered
      // by actually stopping Redis during Phase 1 verification.
      await withTimeout(this.redis.ping(), 2_000, 'redis');
      return check.up();
    } catch (error) {
      return check.down({ message: (error as Error).message });
    }
  }
}

/** A dependency probe that can hang is worse than one that fails. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} health check timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
