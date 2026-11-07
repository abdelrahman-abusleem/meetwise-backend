import { Module } from '@nestjs/common';

import { DatabaseModule } from '@meetwise/infrastructure/database';

import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { LicenseController } from './license.controller';
import { LicenseService } from './license.service';
import { LicenseVerifierService } from './license-verifier.service';

@Module({
  imports: [DatabaseModule, SystemSettingsModule],
  controllers: [LicenseController],
  providers: [LicenseService, LicenseVerifierService],
  exports: [LicenseService, LicenseVerifierService],
})
export class LicenseModule {}
