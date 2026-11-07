import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EnvironmentVariables } from '@meetwise/infrastructure/config';
import { PrismaService } from '@meetwise/infrastructure/database';
import { RedisService } from '@meetwise/infrastructure/redis';

import {
  AUTH_TOKEN_VERSION_KEY_PREFIX,
  AUTH_USER_ACTIVE_KEY_PREFIX,
} from '../../../common/constants/auth.constants';

interface UserSessionState {
  tokenVersion: number;
  isActive: boolean;
}

@Injectable()
export class AuthSessionService {
  private readonly logger = new Logger(AuthSessionService.name);
  private readonly sessionTtlSeconds: number;

  constructor(
    private readonly redisService: RedisService,
    private readonly prismaService: PrismaService,
    configService: ConfigService<EnvironmentVariables, true>,
  ) {
    this.sessionTtlSeconds = configService.getOrThrow(
      'JWT_REFRESH_TTL_SECONDS',
    );
  }

  async create(
    userId: string,
    tokenVersion: number,
    isActive: boolean,
  ): Promise<void> {
    await this.cacheState(userId, {
      tokenVersion,
      isActive,
    });
  }

  async isValid(userId: string, tokenVersion: number): Promise<boolean> {
    const state = await this.getState(userId);

    if (state === null) {
      return false;
    }

    return state.tokenVersion === tokenVersion && state.isActive === true;
  }

  async clearCache(userId: string): Promise<void> {
    try {
      await this.redisService.deleteMany([
        this.getTokenVersionKey(userId),
        this.getUserActiveKey(userId),
      ]);
    } catch {
      this.logWarning('clearCache');
    }
  }

  async updateActiveState(userId: string, isActive: boolean): Promise<void> {
    try {
      await this.redisService.set(
        this.getUserActiveKey(userId),
        isActive ? 1 : 0,
        this.sessionTtlSeconds,
      );
    } catch {
      this.logWarning('updateActiveState');
    }
  }

  private async getState(userId: string): Promise<UserSessionState | null> {
    try {
      const [storedTokenVersion, activeValue] = await Promise.all([
        this.redisService.getNumber(this.getTokenVersionKey(userId)),
        this.redisService.get(this.getUserActiveKey(userId)),
      ]);

      if (storedTokenVersion !== null && activeValue !== null) {
        return {
          tokenVersion: storedTokenVersion,
          isActive: activeValue === '1',
        };
      }
    } catch {
      this.logWarning('getState');
    }

    return this.getStateFromDatabase(userId);
  }

  private async getStateFromDatabase(
    userId: string,
  ): Promise<UserSessionState | null> {
    const user = await this.prismaService.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        tokenVersion: true,
        isActive: true,
      },
    });

    if (!user) {
      return null;
    }

    const state: UserSessionState = {
      tokenVersion: user.tokenVersion,
      isActive: user.isActive,
    };

    void this.cacheState(userId, state);

    return state;
  }

  private async cacheState(
    userId: string,
    state: UserSessionState,
  ): Promise<void> {
    try {
      await Promise.all([
        this.redisService.set(
          this.getTokenVersionKey(userId),
          state.tokenVersion,
          this.sessionTtlSeconds,
        ),
        this.redisService.set(
          this.getUserActiveKey(userId),
          state.isActive ? 1 : 0,
          this.sessionTtlSeconds,
        ),
      ]);
    } catch {
      this.logWarning('cacheState');
    }
  }

  private logWarning(
    operation: 'clearCache' | 'updateActiveState' | 'getState' | 'cacheState',
  ): void {
    this.logger.warn(`Redis session ${operation} failed`);
  }

  private getTokenVersionKey(userId: string): string {
    return `${AUTH_TOKEN_VERSION_KEY_PREFIX}:${userId}`;
  }

  private getUserActiveKey(userId: string): string {
    return `${AUTH_USER_ACTIVE_KEY_PREFIX}:${userId}`;
  }
}
