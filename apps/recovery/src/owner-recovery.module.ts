import { Module } from '@nestjs/common';
import { DatabaseModule } from '@meetwise/infrastructure/database';
import { PasswordHasherService } from '../../api/src/modules/auth/services/password-hasher.service';
import { OwnerRecoveryService } from './owner-recovery.service';

@Module({
  imports: [DatabaseModule],
  providers: [OwnerRecoveryService, PasswordHasherService],
  exports: [OwnerRecoveryService],
})
export class OwnerRecoveryModule {}
