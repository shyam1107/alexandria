import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AccessTokenGuard } from './auth.guards';
import { LoginRateLimitGuard } from './login-rate-limit.guard';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post('register') @UseGuards(LoginRateLimitGuard) register(@Body() body: RegisterDto) { return this.auth.register(body.email, body.password, body.workspaceName); }
  // Credential stuffing is the one attack that pays for itself at demo scale;
  // the guard denies before scrypt is ever paid.
  @Post('login') @UseGuards(LoginRateLimitGuard) login(@Body() body: LoginDto) { return this.auth.login(body.email, body.password); }
  @Post('refresh') refresh(@Body() body: RefreshDto) { return this.auth.refresh(body.refreshToken); }
  @Post('logout') @UseGuards(AccessTokenGuard) logout(@Body() body: RefreshDto) { return this.auth.logout(body.refreshToken); }
}