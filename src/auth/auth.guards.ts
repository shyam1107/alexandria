import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException, Inject } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import type { Db } from '../database/database.module';
import { DRIZZLE } from '../database/database.module';
import { memberships } from '../database/schema';
import { AuthService } from './auth.service';
import type { RequestWithAuth } from './auth.types';
import { BEARER_PREFIX } from './auth.constants';

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const header = request.headers.authorization;
    if (!header || Array.isArray(header) || !header.startsWith(BEARER_PREFIX)) throw new UnauthorizedException('Bearer token required');
    request.user = this.auth.verifyAccessToken(header.slice(BEARER_PREFIX.length));
    return true;
  }
}

@Injectable()
export class WorkspaceMemberGuard implements CanActivate {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const workspaceId = request.headers['x-workspace-id'];
    if (!request.user || typeof workspaceId !== 'string') throw new ForbiddenException('Workspace context required');
    const [membership] = await this.db.select({ workspaceId: memberships.workspaceId }).from(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, request.user.userId)));
    if (!membership) throw new ForbiddenException('User is not a member of this workspace');
    request.workspaceId = membership.workspaceId;
    return true;
  }
}