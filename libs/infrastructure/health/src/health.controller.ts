import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
} from '@nestjs/terminus';
import { DatabaseHealthIndicator } from './database.health';
import { RedisHealthIndicator } from './redis.health';

@Controller('health')
export class HealthController {
  constructor(
    private readonly healthCheckService: HealthCheckService,
    private readonly databaseHealthIndicator: DatabaseHealthIndicator,
    private readonly redisHealthIndicator: RedisHealthIndicator,
  ) {}

  @Get('live')
  live(): { status: string } {
    return {
      status: 'ok',
    };
  }

  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.healthCheckService.check([
      () => this.databaseHealthIndicator.isHealthy(),
      () => this.redisHealthIndicator.isHealthy(),
    ]);
  }
}
