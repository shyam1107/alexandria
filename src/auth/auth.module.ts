import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AccessTokenGuard, WorkspaceMemberGuard } from './auth.guards';

@Module({ controllers: [AuthController], providers: [AuthService, AccessTokenGuard, WorkspaceMemberGuard], exports: [AuthService, AccessTokenGuard, WorkspaceMemberGuard] })
export class AuthModule {}