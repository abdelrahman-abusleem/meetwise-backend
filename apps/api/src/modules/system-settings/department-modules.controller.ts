import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { DepartmentKind, SystemRole } from '@meetwise/infrastructure/database';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { AuthOriginGuard } from '../auth/guards/auth-origin.guard';
import { SystemRolesGuard } from '../auth/guards/system-roles.guard';
import { RequireSystemRoles } from '../auth/decorators/system-roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { DepartmentModulesService } from './department-modules.service';

@Controller('settings/modules')
@UseGuards(AccessTokenGuard, SystemRolesGuard, AuthOriginGuard)
@RequireSystemRoles(SystemRole.OWNER, SystemRole.MANAGER)
export class DepartmentModulesController {
  constructor(private readonly modules: DepartmentModulesService) {}

  @Get()
  list() {
    return this.modules.list();
  }

  @Post(':kind/enable')
  @HttpCode(HttpStatus.OK)
  enable(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('kind') rawKind: string,
  ) {
    const kind =
      rawKind === DepartmentKind.TECH
        ? DepartmentKind.TECH
        : rawKind === DepartmentKind.SALES
          ? DepartmentKind.SALES
          : undefined;
    if (!kind) throw new BadRequestException('Unknown module kind');
    return this.modules.enable(actor, kind);
  }
}
