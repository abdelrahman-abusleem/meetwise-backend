import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AdministrativeResetService } from './administrative-reset.service';
import { AuthOriginGuard } from './guards/auth-origin.guard';
import { CookieService } from './services/cookie.service';
import { TemporaryPasswordDto } from './dto/temporary-password.dto';

@Controller('auth')
@UseGuards(AuthOriginGuard)
export class TemporaryPasswordController {
  constructor(
    private readonly resets: AdministrativeResetService,
    private readonly cookies: CookieService,
  ) {}

  @Post('temporary-password')
  @HttpCode(200)
  async consume(
    @Headers('authorization') authorization: unknown,
    @Body() body: TemporaryPasswordDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (typeof authorization !== 'string')
      throw new UnauthorizedException('Temporary credential required');
    const match = /^Bearer ([^ ]+)$/i.exec(authorization);
    if (!match)
      throw new UnauthorizedException('Temporary credential required');
    await this.resets.consume(match[1], body.newPassword);
    this.cookies.clearAuthCookies(response);
    return { message: 'Password changed. Please sign in.' };
  }
}
