import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.getOrThrow<string>('REDIS_HOST');
    const port = this.configService.getOrThrow<number>('REDIS_PORT');

    this.client = new Redis({
      host,
      port,
      lazyConnect: true,

      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,

      retryStrategy: (attempt: number) => Math.min(attempt * 200, 2_000),
    });

    this.client.on('error', (error: Error) => {
      this.logger.warn(`Redis connection error: ${error.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
      await this.client.ping();
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Redis connection failed';

      this.logger.warn(message);
    }
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }

  getClient(): Redis {
    return this.client;
  }
}
