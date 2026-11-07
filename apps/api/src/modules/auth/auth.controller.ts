import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  Patch,
  UseGuards,
} from '@nestjs/common';
import type { Response, Request } from 'express';

import { AuthOriginGuard } from './guards/auth-origin.guard';
import type { AuthenticatedUser } from './auth.types';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { AccessTokenGuard } from './guards/access-token.guard';
import { CookieService } from './services/cookie.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';

@Controller('auth')
@UseGuards(AuthOriginGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly cookieService: CookieService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.login(dto);

    this.cookieService.setAuthCookies(response, result);

    return {
      message: 'Login successful',
      user: result.user,
    };
  }

  @Get('me')
  @UseGuards(AccessTokenGuard)
  async getCurrentUser(@CurrentUser() authenticatedUser: AuthenticatedUser) {
    const user = await this.authService.getCurrentUser(authenticatedUser.id);

    return {
      user,
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const refreshToken = this.cookieService.getRefreshToken(request);

    const result = await this.authService.refresh(refreshToken);

    this.cookieService.setAuthCookies(response, result);

    return {
      message: 'Token refreshed successfully',
      user: result.user,
    };
  }

  @Post('logout')
  @UseGuards(AccessTokenGuard)
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() authenticatedUser: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.authService.logout(
      authenticatedUser.id,
      authenticatedUser.familyId,
    );

    this.cookieService.clearAuthCookies(response);

    return {
      message: 'Logout successful',
    };
  }

  @Patch('password')
  @UseGuards(AccessTokenGuard)
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentUser() authenticatedUser: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.authService.changePassword(
      authenticatedUser.id,
      authenticatedUser.tokenVersion,
      dto.currentPassword,
      dto.newPassword,
      authenticatedUser.familyId,
    );

    this.cookieService.clearAuthCookies(response);

    return {
      message: 'Password changed successfully. Please log in again.',
    };
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.authService.forgotPassword(dto.email);

    return {
      message:
        'If an eligible account exists, the reset request has been accepted.',
    };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.authService.resetPassword(dto.resetToken, dto.newPassword);

    this.cookieService.clearAuthCookies(response);

    return {
      message: 'Password reset successfully. Please log in again.',
    };
  }
}
