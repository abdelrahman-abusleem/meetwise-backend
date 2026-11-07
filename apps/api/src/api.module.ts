import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';

import { ConfigModule } from '@meetwise/infrastructure/config';
import { DatabaseModule } from '@meetwise/infrastructure/database';
import { HealthModule } from '@meetwise/infrastructure/health';
import { QueueModule } from '@meetwise/infrastructure/queue';
import { RedisModule } from '@meetwise/infrastructure/redis';

import { ApiController } from './api.controller';
import { ApiService } from './api.service';
import { HttpLoggingMiddleware } from './middleware/http-logging.middleware';
import { SystemQueueService } from './services/system-queue.service';
import { SystemSettingsModule } from './modules/system-settings/system-settings.module';
import { SetupModule } from './modules/setup/setup.module';
import { AuthModule } from './modules/auth/auth.module';
import { DepartmentMembershipsModule } from './modules/departments/department-memberships.module';
import { MeetingsModule } from './modules/meetings/meetings.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    RedisModule,
    QueueModule,
    HealthModule,
    SystemSettingsModule,
    SetupModule,
    AuthModule,
    DepartmentMembershipsModule,
    MeetingsModule,
  ],
  controllers: [ApiController],
  providers: [ApiService, SystemQueueService],
})
export class ApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(HttpLoggingMiddleware)
      .exclude(
        {
          path: 'health/live',
          method: RequestMethod.GET,
        },
        {
          path: 'health/ready',
          method: RequestMethod.GET,
        },
      )
      .forRoutes('{*splat}');
  }
}
