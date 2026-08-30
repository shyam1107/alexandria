import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { RequestWithAuth } from '../auth/auth.types';
import { RateLimiterService } from '../rate-limit/rate-limiter.service';

/**
 * Chat entry limiting — TWO units, because a chat request is unlike any
 * other request this API serves: it holds a connection for ~30 seconds and
 * its cost varies from 50 tokens to 4,000. Request-count alone cannot bound
 * either property, so:
 *
 * 1. STREAM-START WINDOW — how many streams a workspace may START per
 *    minute. The burst brake.
 *
 * 2. CONCURRENT-STREAM LEASE — how many streams a workspace may hold OPEN
 *    at once. The connection-exhaustion bound: 10 pool connections and N
 *    parallel SSE streams would starve every other endpoint. The lease is
 *    a ZSET of {stream id -> expiry}: a process killed mid-stream frees
 *    its slot at lease expiry (self-healing), and a clean end releases
 *    early via the controller's finally — the lease id rides the request
 *    object, which the controller reads on stream end.
 *
 * Placement: AFTER WorkspaceMemberGuard (limiting needs the workspace id)
 * and BEFORE the handler — the SSE 200 is committed lazily by the first
 * frame, so a 429 thrown from a guard is a real HTTP status on the wire,
 * never an error frame. The pre-frame-deadline contract (WS2) is untouched.
 *
 * Limiter failure fails OPEN, same reasoning as the login guard: a Redis
 * outage degrades protection, not availability.
 */
@Injectable()
export class ChatRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: RateLimiterService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & RequestWithAuth>();
    const workspaceId = request.workspaceId!;

    const streamId = randomUUID();
    // The lease outlives the pre-frame deadline + a full generous stream:
    // its TTL is the crash-cleanliness fallback, not the normal path (the
    // controller releases on stream end).
    const leaseTtlMs = 120_000;

    const [startsAllowed, leaseGranted] = await Promise.all([
      this.limiter.consume(`rl:chat:starts:${workspaceId}`, 20, 60).catch(() => true),
      this.limiter.acquireLease(`rl:chat:streams:${workspaceId}`, streamId, 5, leaseTtlMs).catch(() => true),
    ]);
    if (!startsAllowed) throw new HttpException('Chat rate limit exceeded; slow down', 429);
    if (!leaseGranted) throw new HttpException('Too many concurrent streams for this workspace', 429);

    // The controller releases this lease when the stream ends (or the
    // response closes); on guard failure above nothing was registered.
    request.streamLease = { key: `rl:chat:streams:${workspaceId}`, id: streamId };
    return true;
  }
}