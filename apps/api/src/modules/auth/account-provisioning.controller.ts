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
import { AccountProvisioningService } from './account-provisioning.service';
import { ProvisionAccountDto } from './dto/provision-account.dto';
import type { AuthenticatedUser } from './auth.types';
import { CurrentUser } from './decorators/current-user.decorator';
import { RequireSystemRoles } from './decorators/system-roles.decorator';
import { AuthOriginGuard } from './guards/auth-origin.guard';
import { AccessTokenGuard } from './guards/access-token.guard';
import { SystemRolesGuard } from './guards/system-roles.guard';
@Controller('users')
@UseGuards(AuthOriginGuard, AccessTokenGuard, SystemRolesGuard)
@RequireSystemRoles(SystemRole.OWNER, SystemRole.MANAGER)
export class AccountProvisioningController {
  constructor(private readonly provisioning: AccountProvisioningService) {}
  @Post()
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  provision(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: ProvisionAccountDto,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.provisioning.provision(actor, dto, key);
  }
  @Post(':id/activation-credentials')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  replace(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
  ) {
    this.empty(body);
    return this.provisioning.replace(actor, id, key);
  }
  @Post(':id/activation-credentials/revoke')
  @HttpCode(204)
  revoke(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    this.empty(body);
    return this.provisioning.revoke(actor, id);
  }
  private empty(body: unknown) {
    if (
      body !== undefined &&
      (!body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length)
    )
      throw new BadRequestException('No request parameters accepted');
  }
}
