import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { RequestWithAuth } from '../auth/auth.types';
import { RateLimiterService } from '../rate-limit/rate-limiter.service';

/**
 * Per-workspace fixed window for search. A search is a cheap, fast request
 * (two index probes + a merge) — unlike chat it holds no connection — so a
 * plain request-count window is the right unit. It exists to keep a hot
 * loop (a script, a runaway client) from saturating the pool with
 * retrieval work, not to price the endpoint.
 *
 * Runs after WorkspaceMemberGuard (needs workspaceId), fails open on
 * limiter errors for the same availability reason as the other guards.
 */
@Injectable()
export class SearchRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: RateLimiterService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & RequestWithAuth>();
    const allowed = await this.limiter.consume(`rl:search:${request.workspaceId!}`, 60, 60).catch(() => true);
    if (!allowed) throw new HttpException('Search rate limit exceeded', 429);
    return true;
  }
}