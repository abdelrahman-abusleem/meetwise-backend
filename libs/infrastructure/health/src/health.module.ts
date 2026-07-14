import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { DatabaseModule } from '@meetwise/infrastructure/database';
import { RedisModule } from '@meetwise/infrastructure/redis';
import { DatabaseHealthIndicator } from './database.health';
import { HealthController } from './health.controller';
import { RedisHealthIndicator } from './redis.health';

@Module({
  imports: [TerminusModule, DatabaseModule, RedisModule],
  controllers: [HealthController],
  providers: [DatabaseHealthIndicator, RedisHealthIndicator],
})
export class HealthModule {}
