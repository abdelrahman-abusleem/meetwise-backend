import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import { createHmac } from 'node:crypto';

import { EnvironmentVariables } from '@meetwise/infrastructure/config';
import { RedisService } from '@meetwise/infrastructure/redis';

import {
  INVALID_PASSWORD_RESET_TOKEN,
  PASSWORD_RESET_KEY_PREFIX,
  PASSWORD_RESET_SERVICE_UNAVAILABLE,
  PASSWORD_RESET_TOKEN_VERSION,
} from './password-reset.constants';

import { CONSUME_PASSWORD_RESET_SCRIPT } from './scripts/consume-password-reset.script';
import { ISSUE_PASSWORD_RESET_SCRIPT } from './scripts/issue-password-reset.script';
import { PASSWORD_RESET_ISSUE_RESULT } from './password-reset.types';

export interface PasswordResetIdentity {
  userId: string;
  tokenVersion: number;
}

const RESET_TOKEN_PARTS_COUNT = 4;
const RESET_TOKEN_MAX_LENGTH = 512;
const RESET_TOKEN_RANDOM_SECRET_LENGTH = 43;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

@Injectable()
export class PasswordResetTokenService {
  private readonly logger = new Logger(PasswordResetTokenService.name);

  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(
    private readonly redisService: RedisService,
    configService: ConfigService<EnvironmentVariables, true>,
  ) {
    this.secret = configService.getOrThrow('PASSWORD_RESET_SECRET', {
      infer: true,
    });

    this.ttlSeconds = configService.getOrThrow('PASSWORD_RESET_TTL_SECONDS', {
      infer: true,
    });
  }

  async issueForRequest(
    userId: string,
    requestId: string,
    requestTimestamp: number,
    tokenVersion: number,
  ): Promise<string | null> {
    if (
      !isUUID(userId) ||
      !Number.isInteger(tokenVersion) ||
      tokenVersion < 0 ||
      tokenVersion > 2147483647 ||
      typeof requestId !== 'string' ||
      !requestId.length ||
      requestId.length > 256 ||
      !Number.isSafeInteger(requestTimestamp) ||
      requestTimestamp < 0
    )
      throw new BadRequestException(INVALID_PASSWORD_RESET_TOKEN);
    const randomSecret = createHmac('sha256', this.secret)
      .update(
        `password-reset:v2:${userId}:${tokenVersion}:${requestId}`,
        'utf8',
      )
      .digest('base64url');

    const rawToken = [
      PASSWORD_RESET_TOKEN_VERSION,
      userId,
      tokenVersion,
      randomSecret,
    ].join('.');

    const tokenHash = this.hash(rawToken);

    const storedValue = JSON.stringify({
      tokenHash,
      requestId,
      requestTimestamp,
      tokenVersion,
    });

    let result: number;

    try {
      const scriptResult = await this.redisService.evalScript(
        ISSUE_PASSWORD_RESET_SCRIPT,
        [this.getResetKey(userId)],
        [storedValue, requestId, requestTimestamp, this.ttlSeconds],
      );

      result = Number(scriptResult);
    } catch {
      this.logRedisFailure('issue');

      throw new ServiceUnavailableException(PASSWORD_RESET_SERVICE_UNAVAILABLE);
    }

    if (result === PASSWORD_RESET_ISSUE_RESULT.STALE) {
      return null;
    }

    if (
      result === PASSWORD_RESET_ISSUE_RESULT.CREATED ||
      result === PASSWORD_RESET_ISSUE_RESULT.SAME_REQUEST
    ) {
      return rawToken;
    }

    this.logger.error('Unexpected password reset issue result');

    throw new ServiceUnavailableException(PASSWORD_RESET_SERVICE_UNAVAILABLE);
  }

  async consume(rawToken: string): Promise<PasswordResetIdentity> {
    const normalizedToken = rawToken.trim();
    const identity = this.extractIdentity(normalizedToken);
    const userId = identity.userId;
    const tokenHash = this.hash(normalizedToken);

    let consumed: boolean;

    try {
      const result = await this.redisService.evalScript(
        CONSUME_PASSWORD_RESET_SCRIPT,
        [this.getResetKey(userId)],
        [tokenHash],
      );

      consumed = result === 1;
    } catch {
      this.logRedisFailure('consume');

      throw new ServiceUnavailableException(PASSWORD_RESET_SERVICE_UNAVAILABLE);
    }

    if (!consumed) {
      throw new BadRequestException(INVALID_PASSWORD_RESET_TOKEN);
    }

    return identity;
  }

  private extractIdentity(rawToken: string): PasswordResetIdentity {
    if (rawToken.length === 0 || rawToken.length > RESET_TOKEN_MAX_LENGTH) {
      throw new BadRequestException(INVALID_PASSWORD_RESET_TOKEN);
    }

    const parts = rawToken.split('.');

    if (parts.length !== RESET_TOKEN_PARTS_COUNT) {
      throw new BadRequestException(INVALID_PASSWORD_RESET_TOKEN);
    }

    const [version, userId, epoch, randomSecret] = parts;

    const randomSecretIsValid =
      randomSecret.length === RESET_TOKEN_RANDOM_SECRET_LENGTH &&
      BASE64URL_PATTERN.test(randomSecret);

    if (
      version !== PASSWORD_RESET_TOKEN_VERSION ||
      !isUUID(userId) ||
      !/^(0|[1-9][0-9]{0,9})$/.test(epoch) ||
      Number(epoch) > 2147483647 ||
      !randomSecretIsValid
    ) {
      throw new BadRequestException(INVALID_PASSWORD_RESET_TOKEN);
    }

    return { userId, tokenVersion: Number(epoch) };
  }

  private hash(rawToken: string): string {
    return createHmac('sha256', this.secret)
      .update(rawToken, 'utf8')
      .digest('hex');
  }

  private getResetKey(userId: string): string {
    return `${PASSWORD_RESET_KEY_PREFIX}:${userId}`;
  }

  private logRedisFailure(operation: 'issue' | 'consume'): void {
    this.logger.warn(`Password reset token ${operation} failed`);
  }
}
