import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { EnvironmentVariables } from '@meetwise/infrastructure/config';
import { SystemRole } from '@meetwise/infrastructure/database';
import {
  BEARER_TOKEN_TYPE,
  INVALID_ACCESS_TOKEN,
  INVALID_REFRESH_TOKEN,
} from '../../../common/constants/auth.constants';
import type {
  AuthTokenPair,
  AuthTokenPayload,
  AuthTokenType,
  TokenUser,
} from '../auth.types';

@Injectable()
export class AuthTokenService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtlSeconds = 900;
  private readonly refreshTtlSeconds = 604800;
  constructor(
    private readonly jwtService: JwtService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.accessSecret = config.getOrThrow('JWT_ACCESS_SECRET', { infer: true });
    this.refreshSecret = config.getOrThrow('JWT_REFRESH_SECRET', {
      infer: true,
    });
    if (
      config.getOrThrow('JWT_ACCESS_TTL_SECONDS', { infer: true }) !==
        this.accessTtlSeconds ||
      config.getOrThrow('JWT_REFRESH_TTL_SECONDS', { infer: true }) !==
        this.refreshTtlSeconds
    ) {
      throw new Error('JWT lifetimes must match the approved session policy');
    }
  }
  async issueTokenPair(
    user: TokenUser,
    familyId: string,
  ): Promise<AuthTokenPair> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const base = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
      sid: familyId,
      v: 2 as const,
      iat: issuedAt,
    };
    const [accessToken, refreshToken] = await Promise.all([
      this.signToken(base, 'access', this.accessSecret, this.accessTtlSeconds),
      this.signToken(
        base,
        'refresh',
        this.refreshSecret,
        this.refreshTtlSeconds,
      ),
    ]);
    return {
      accessToken,
      refreshToken,
      tokenType: BEARER_TOKEN_TYPE,
      accessTokenExpiresIn: this.accessTtlSeconds,
      refreshTokenExpiresIn: this.refreshTtlSeconds,
      refreshTokenExpiresAt: new Date(
        (issuedAt + this.refreshTtlSeconds) * 1000,
      ),
    };
  }
  verifyAccessToken(token: string): Promise<AuthTokenPayload> {
    return this.verifyToken(
      token,
      'access',
      this.accessSecret,
      INVALID_ACCESS_TOKEN,
    );
  }
  verifyRefreshToken(token: string): Promise<AuthTokenPayload> {
    return this.verifyToken(
      token,
      'refresh',
      this.refreshSecret,
      INVALID_REFRESH_TOKEN,
    );
  }
  private async verifyToken(
    token: string,
    type: AuthTokenType,
    secret: string,
    message: string,
  ): Promise<AuthTokenPayload> {
    try {
      const payload: unknown = await this.jwtService.verifyAsync(token, {
        secret,
        algorithms: ['HS256'],
        issuer: 'meetwise',
        audience: 'meetwise-api',
      });
      if (!this.hasValidClaims(payload, type))
        throw new UnauthorizedException(message);
      return payload;
    } catch {
      throw new UnauthorizedException(message);
    }
  }
  private hasValidClaims(
    value: unknown,
    type: AuthTokenType,
  ): value is AuthTokenPayload {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    const p = value as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    const ttl =
      type === 'access' ? this.accessTtlSeconds : this.refreshTtlSeconds;
    return (
      p.v === 2 &&
      p.tokenType === type &&
      typeof p.sub === 'string' &&
      isUUID(p.sub) &&
      typeof p.sid === 'string' &&
      isUUID(p.sid) &&
      typeof p.jti === 'string' &&
      isUUID(p.jti) &&
      typeof p.email === 'string' &&
      p.email.length > 0 &&
      typeof p.role === 'string' &&
      Object.values(SystemRole).includes(p.role as SystemRole) &&
      typeof p.tokenVersion === 'number' &&
      Number.isSafeInteger(p.tokenVersion) &&
      p.tokenVersion >= 0 &&
      typeof p.iat === 'number' &&
      Number.isSafeInteger(p.iat) &&
      p.iat <= now &&
      typeof p.exp === 'number' &&
      Number.isSafeInteger(p.exp) &&
      p.exp > now &&
      p.exp - p.iat === ttl
    );
  }
  private signToken(
    base: Omit<AuthTokenPayload, 'tokenType' | 'jti' | 'exp'>,
    tokenType: AuthTokenType,
    secret: string,
    expiresIn: number,
  ): Promise<string> {
    return this.jwtService.signAsync(
      { ...base, tokenType, jti: randomUUID() },
      {
        secret,
        algorithm: 'HS256',
        issuer: 'meetwise',
        audience: 'meetwise-api',
        expiresIn,
      },
    );
  }
}
