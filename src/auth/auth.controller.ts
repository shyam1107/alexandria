import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { AccessTokenGuard } from './auth.guards';

class RegisterDto { @IsEmail() email!: string; @IsString() @MinLength(12) password!: string; @IsString() @IsNotEmpty() workspaceName!: string; }
class LoginDto { @IsEmail() email!: string; @IsString() @IsNotEmpty() password!: string; }
class RefreshDto { @IsString() @IsNotEmpty() refreshToken!: string; }

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post('register') register(@Body() body: RegisterDto) { return this.auth.register(body.email, body.password, body.workspaceName); }
  @Post('login') login(@Body() body: LoginDto) { return this.auth.login(body.email, body.password); }
  @Post('refresh') refresh(@Body() body: RefreshDto) { return this.auth.refresh(body.refreshToken); }
  @Post('logout') @UseGuards(AccessTokenGuard) logout(@Body() body: RefreshDto) { return this.auth.logout(body.refreshToken); }
}