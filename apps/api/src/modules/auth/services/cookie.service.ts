import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';

import {
  EnvironmentVariables,
  NodeEnvironment,
} from '@meetwise/infrastructure/config';

import {
  ACCESS_TOKEN_COOKIE_NAME,
  INVALID_ACCESS_TOKEN,
  INVALID_REFRESH_TOKEN,
  REFRESH_TOKEN_COOKIE_NAME,
} from '../../../common/constants/auth.constants';
import type { AuthTokenPair } from '../auth.types';

@Injectable()
export class CookieService {
  private readonly secure: boolean;
  private readonly accessTokenMaxAgeMs: number;
  private readonly refreshTokenMaxAgeMs: number;

  constructor(configService: ConfigService<EnvironmentVariables, true>) {
    this.secure =
      configService.getOrThrow('NODE_ENV', {
        infer: true,
      }) === NodeEnvironment.PRODUCTION;

    this.accessTokenMaxAgeMs =
      configService.getOrThrow('JWT_ACCESS_TTL_SECONDS', {
        infer: true,
      }) * 1_000;

    this.refreshTokenMaxAgeMs =
      configService.getOrThrow('JWT_REFRESH_TTL_SECONDS', {
        infer: true,
      }) * 1_000;
  }

  setAuthCookies(response: Response, tokens: AuthTokenPair): void {
    response.cookie(
      ACCESS_TOKEN_COOKIE_NAME,
      tokens.accessToken,
      this.getCookieOptions(this.accessTokenMaxAgeMs),
    );

    response.cookie(
      REFRESH_TOKEN_COOKIE_NAME,
      tokens.refreshToken,
      this.getCookieOptions(this.refreshTokenMaxAgeMs),
    );
  }

  clearAuthCookies(response: Response): void {
    response.clearCookie(ACCESS_TOKEN_COOKIE_NAME, this.getBaseCookieOptions());

    response.clearCookie(
      REFRESH_TOKEN_COOKIE_NAME,
      this.getBaseCookieOptions(),
    );
  }

  getAccessToken(request: Request): string {
    const accessToken: unknown = request.cookies?.[ACCESS_TOKEN_COOKIE_NAME];

    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new UnauthorizedException(INVALID_ACCESS_TOKEN);
    }

    return accessToken;
  }

  getRefreshToken(request: Request): string {
    const refreshToken: unknown = request.cookies?.[REFRESH_TOKEN_COOKIE_NAME];

    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
    }

    return refreshToken;
  }

  private getBaseCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: '/',
    };
  }

  private getCookieOptions(maxAge: number): CookieOptions {
    return {
      ...this.getBaseCookieOptions(),
      maxAge,
    };
  }
}
