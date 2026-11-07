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
import { AccountProvisioningService } from './account-provisioning.service';
import { ActivateAccountDto } from './dto/activate-account.dto';
import { AuthOriginGuard } from './guards/auth-origin.guard';
import { CookieService } from './services/cookie.service';
@Controller('auth')
@UseGuards(AuthOriginGuard)
export class AccountActivationController {
  constructor(
    private readonly provisioning: AccountProvisioningService,
    private readonly cookies: CookieService,
  ) {}
  @Post('accept-invite')
  @HttpCode(200)
  async activate(
    @Headers('authorization') header: unknown,
    @Body() dto: ActivateAccountDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const match =
      typeof header === 'string' ? /^Bearer ([^ ]+)$/i.exec(header) : null;
    if (!match)
      throw new UnauthorizedException('Activation credential required');
    await this.provisioning.activate(match[1], dto.newPassword);
    this.cookies.clearAuthCookies(response);
    return {
      message: 'Account activated. Please sign in.',
      emailOwnershipVerified: false,
    };
  }
}
