import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { RequestWithAuth } from '../auth/auth.types';
import { UsageLedger } from '../llm/usage-ledger';

/**
 * Phase 7 quota enforcement — the guard that makes Phase 6's ledger ACT.
 *
 * The check is monthly micro-USD consumption: the Redis counter incremented
 * inside UsageLedger.record, the single choke point where cost is computed,
 * so counter and ledger move together. Over-budget denies with 402 — the
 * tenant's state is "paid plan exhausted", which is NOT a rate problem
 * (429) and NOT a server fault (5xx): distinct status, distinct meaning,
 * distinct alert policy.
 *
 * Placement: pre-frame (denial is a real HTTP status, never an SSE frame —
 * the same placement contract as the rate-limit guard, protected by the
 * same heartbeat work).
 *
 * OVERSHOOT IS BOUNDED AND ACCEPTED, by decision: the check is
 * consumption-so-far because a call's cost is known only when it finishes,
 * and two concurrent requests can both pass a check neither would pass
 * alone. Worst case is one request's spend past the cap. Pre-authorizing a
 * worst-case estimate instead would reject legitimate requests near
 * month-end to close a hole measured in fractions of a cent.
 *
 * Counter read failure fails OPEN (Redis down => degraded protection, not
 * an outage — the same availability call as every other guard). What does
 * NOT fail open is the unpriced-model case: that check runs at BOOT in the
 * LLM module factory, fail-fast, because an unpriced chain is a
 * configuration error and no amount of traffic self-heals it.
 */
@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(private readonly ledger: UsageLedger) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & RequestWithAuth>();
    const within = await this.ledger.withinBudget(request.workspaceId!).catch(() => true);
    if (!within) {
      throw new HttpException('Monthly LLM budget exhausted for this workspace', 402);
    }
    return true;
  }
}