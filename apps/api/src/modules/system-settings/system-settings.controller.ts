import { UseGuards } from '@nestjs/common';
import { SystemRole } from '@meetwise/infrastructure/database';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { SystemRolesGuard } from '../auth/guards/system-roles.guard';
import { RequireSystemRoles } from '../auth/decorators/system-roles.decorator';
import { Controller, Get } from '@nestjs/common';

import { SystemSettingsService } from './system-settings.service';

@Controller('system/settings')
@UseGuards(AccessTokenGuard, SystemRolesGuard)
@RequireSystemRoles(SystemRole.OWNER, SystemRole.MANAGER)
export class SystemSettingsController {
  constructor(private readonly systemSettingsService: SystemSettingsService) {}

  @Get()
  getSettings() {
    return this.systemSettingsService.getOrCreate();
  }
}
