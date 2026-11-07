import { Module } from '@nestjs/common';

import { ConfigModule } from '@meetwise/infrastructure/config';
import { RedisModule } from '@meetwise/infrastructure/redis';

import { PasswordResetTokenService } from './password-reset-token.service';

@Module({
  imports: [ConfigModule, RedisModule],
  providers: [PasswordResetTokenService],
  exports: [PasswordResetTokenService],
})
export class SecurityModule {}
