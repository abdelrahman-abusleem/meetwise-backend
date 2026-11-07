import { BotDisplayController } from './bot-display.controller';
import { BotDisplayService } from './bot-display.service';
import { DepartmentModulesController } from './department-modules.controller';
import { DepartmentModulesService } from './department-modules.service';
import { AuthModule } from '../auth/auth.module';
import { Module } from '@nestjs/common';

import { DatabaseModule } from '@meetwise/infrastructure/database';

import { SystemSettingsController } from './system-settings.controller';
import { SystemSettingsService } from './system-settings.service';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [
    SystemSettingsController,
    BotDisplayController,
    DepartmentModulesController,
  ],
  providers: [
    SystemSettingsService,
    BotDisplayService,
    DepartmentModulesService,
  ],
  exports: [SystemSettingsService],
})
export class SystemSettingsModule {}
