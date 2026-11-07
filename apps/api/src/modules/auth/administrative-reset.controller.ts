import {
  BadRequestException,
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SystemRole } from '@meetwise/infrastructure/database';
import type { AuthenticatedUser } from './auth.types';
import { AdministrativeResetService } from './administrative-reset.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { RequireSystemRoles } from './decorators/system-roles.decorator';
import { AccessTokenGuard } from './guards/access-token.guard';
import { AuthOriginGuard } from './guards/auth-origin.guard';
import { SystemRolesGuard } from './guards/system-roles.guard';

@Controller('users')
@UseGuards(AuthOriginGuard, AccessTokenGuard, SystemRolesGuard)
@RequireSystemRoles(SystemRole.OWNER, SystemRole.MANAGER)
export class AdministrativeResetController {
  constructor(private readonly resets: AdministrativeResetService) {}

  @Post(':id/reset-credentials')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  issue(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) userId: string,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
  ) {
    if (
      body !== undefined &&
      (!body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length)
    )
      throw new BadRequestException('Reset issuance accepts no parameters');
    return this.resets.issue(actor, userId, key);
  }
}
