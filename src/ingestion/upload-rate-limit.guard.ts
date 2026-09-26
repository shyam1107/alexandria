import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { RequestWithAuth } from '../auth/auth.types';
import { RateLimiterService } from '../rate-limit/rate-limiter.service';

/**
 * Per-workspace fixed windows for the upload endpoints.
 *
 * COMPLETIONS (the tight one) kick off chunking + embedding, i.e. real spend
 * and worker queue slots — 10/hour.
 *
 * PRESIGNS (the looser one) used to be considered commit-free, but that
 * stopped being true when ContentLength became a signed header: a presign
 * still creates two rows and hands out a signed URL, and an unbounded loop
 * of presigns is unbounded row creation plus signed-URL minting. 30/hour
 * is generous for a human uploading files and tight enough that a runaway
 * client cannot mint thousands of URL/row pairs. Both are fail-open (Redis
 * down => allowed), same as every limiter in this codebase.
 */
@Injectable()
export class UploadRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: RateLimiterService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & RequestWithAuth>();
    // Completion is the surface worth bounding tightest: ingestion begins.
    const allowed = await this.limiter.consume(`rl:upload:${request.workspaceId!}`, 10, 3600).catch(() => true);
    if (!allowed) throw new HttpException('Upload rate limit exceeded', 429);
    return true;
  }
}

@Injectable()
export class PresignRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: RateLimiterService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & RequestWithAuth>();
    const allowed = await this.limiter.consume(`rl:presign:${request.workspaceId!}`, 30, 3600).catch(() => true);
    if (!allowed) throw new HttpException('Upload URL rate limit exceeded', 429);
    return true;
  }
}