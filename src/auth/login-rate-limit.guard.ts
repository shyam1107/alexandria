import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { RateLimiterService } from '../rate-limit/rate-limiter.service';

/**
 * Credential-stuffing guard for the unauthenticated auth surface.
 *
 * Placement: BEFORE the service call, so scrypt is never paid for a request
 * that will be denied — and so the response is a real 429, not a frame.
 *
 * Keying: the source IP AND the submitted email, as separate windows. A
 * stuffing attack from one host trips the IP window; password spraying one
 * account from many hosts trips the email window. Either denies.
 *
 * The limits are deliberately generous for a demo and deliberately present:
 * an unthrottled login endpoint on the public internet is the single most
 * exploited surface a SaaS can ship. Failures of the limiter itself fail
 * OPEN (the guard rejects nothing if Redis is down) — a Redis outage must
 * not turn into an auth outage, and the metrics layer (Phase 7 WS5) makes
 * limiter errors visible.
 */
@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: RateLimiterService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { body?: { email?: string } }>();
    const ip = request.ip ?? 'unknown';
    const email = (request.body?.email ?? 'unknown').toString().trim().toLowerCase();
    const allowed = await this.limiter
      .checkLogin(ip, email, 20, 300, 10, 300)
      .catch(() => true /* limiter failure fails open — see class doc */);
    if (!allowed) throw new HttpException('Too many attempts; try again later', 429);
    return true;
  }
}