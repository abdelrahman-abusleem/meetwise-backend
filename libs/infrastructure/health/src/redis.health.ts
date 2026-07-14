import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { RedisService } from '@meetwise/infrastructure/redis';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly redisService: RedisService,
  ) {}

  async isHealthy(): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check('redis');

    try {
      await this.redisService.getClient().ping();

      return indicator.up();
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Redis check failed';

      return indicator.down({ message });
    }
  }
}
