import { Module } from '@nestjs/common';

import { ConfigModule } from '@meetwise/infrastructure/config';
import { DatabaseModule } from '@meetwise/infrastructure/database';
import { MailModule } from '@meetwise/infrastructure/mail';
import { QueueModule } from '@meetwise/infrastructure/queue';
import { RedisModule } from '@meetwise/infrastructure/redis';
import { SecurityModule } from '@meetwise/security';

import { AuthProcessor } from './processors/auth.processor';
import { SystemProcessor } from './processors/system.processor';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    RedisModule,
    QueueModule,
    MailModule,
    SecurityModule,
  ],
  controllers: [],
  providers: [SystemProcessor, AuthProcessor],
})
export class WorkerModule {}
