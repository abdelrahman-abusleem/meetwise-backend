import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { EnvironmentVariables } from '@meetwise/infrastructure/config';

import { COMPARE_AND_DELETE_SCRIPT } from './scripts/compare-and-delete.script';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(
    private readonly configService: ConfigService<EnvironmentVariables, true>,
  ) {
    const host = this.configService.getOrThrow('REDIS_HOST', {
      infer: true,
    });

    const port = this.configService.getOrThrow('REDIS_PORT', {
      infer: true,
    });

    this.client = new Redis({
      host,
      port,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt: number) => Math.min(attempt * 200, 2_000),
    });

    this.client.on('error', () => {
      this.logger.warn('Redis client error');
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
      await this.client.ping();
    } catch {
      this.logger.warn('Redis startup connection failed');
    }
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(
    key: string,
    value: string | number,
    ttlSeconds?: number,
  ): Promise<void> {
    if (ttlSeconds !== undefined) {
      await this.client.set(key, String(value), 'EX', ttlSeconds);

      return;
    }

    await this.client.set(key, String(value));
  }

  async getNumber(key: string): Promise<number | null> {
    const value = await this.get(key);

    if (value === null) {
      return null;
    }

    const parsedValue = Number(value);

    if (!Number.isFinite(parsedValue)) {
      return null;
    }

    return parsedValue;
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }

    await this.client.del(...keys);
  }

  async evalScript(
    script: string,
    keys: string[],
    args: Array<string | number>,
  ): Promise<unknown> {
    return this.client.eval(script, keys.length, ...keys, ...args.map(String));
  }

  async compareAndDelete(key: string, expectedValue: string): Promise<boolean> {
    const result: unknown = await this.client.eval(
      COMPARE_AND_DELETE_SCRIPT,
      1,
      key,
      expectedValue,
    );

    return Number(result) === 1;
  }
  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);

    return result === 1;
  }

  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.expire(key, ttlSeconds);

    return result === 1;
  }

  isConnected(): boolean {
    return this.client.status === 'ready';
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  getClient(): Redis {
    return this.client;
  }
}
