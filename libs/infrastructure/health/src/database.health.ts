import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { PrismaService } from '@meetwise/infrastructure/database';

@Injectable()
export class DatabaseHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly prismaService: PrismaService,
  ) {}

  async isHealthy(): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check('database');

    try {
      await this.prismaService.$queryRaw`SELECT 1`;

      return indicator.up();
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Database check failed';

      return indicator.down({ message });
    }
  }
}
