import { Module } from '@nestjs/common';
import { ConfigModule } from '@meetwise/infrastructure/config';
import { DatabaseModule } from '@meetwise/infrastructure/database';
import { RedisModule } from '@meetwise/infrastructure/redis';
import { QueueModule } from '@meetwise/infrastructure/queue';
import { SystemProcessor } from './processors/system.processor';

@Module({
  imports: [ConfigModule, DatabaseModule, RedisModule, QueueModule],
  controllers: [],
  providers: [SystemProcessor],
})
export class WorkerModule {}
