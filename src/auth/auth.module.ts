import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AccessTokenGuard, WorkspaceMemberGuard } from './auth.guards';
import { LoginRateLimitGuard } from './login-rate-limit.guard';

@Module({ controllers: [AuthController], providers: [AuthService, AccessTokenGuard, WorkspaceMemberGuard, LoginRateLimitGuard], exports: [AuthService, AccessTokenGuard, WorkspaceMemberGuard] })
export class AuthModule {}