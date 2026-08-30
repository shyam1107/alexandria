import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { RequestWithAuth } from '../auth/auth.types';
import { RateLimiterService } from '../rate-limit/rate-limiter.service';

/**
 * Per-workspace fixed window for upload COMPLETIONS (the endpoint that
 * kicks off chunking + embedding, i.e. real spend and worker queue slots).
 * Presigning stays generous — a presigned URL commits nothing but a MinIO
 * object — but a completion is where ingestion begins, so it is the thing
 * worth bounding. Queue saturation and embedding cost both hang off this.
 */
@Injectable()
export class UploadRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: RateLimiterService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & RequestWithAuth>();
    const allowed = await this.limiter.consume(`rl:upload:${request.workspaceId!}`, 10, 3600).catch(() => true);
    if (!allowed) throw new HttpException('Upload rate limit exceeded', 429);
    return true;
  }
}