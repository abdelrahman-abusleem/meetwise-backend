import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { ConfigModule } from '@meetwise/infrastructure/config';
import { QUEUE_NAMES } from './queue.constants';

@Module({
  imports: [
    ConfigModule,

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.getOrThrow<string>('REDIS_HOST'),
          port: configService.getOrThrow<number>('REDIS_PORT'),
        },
      }),
    }),

    BullModule.registerQueue({
      name: QUEUE_NAMES.SYSTEM,
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
