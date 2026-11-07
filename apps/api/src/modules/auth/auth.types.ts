import type { Request } from 'express';

import type { SystemRole } from '@meetwise/infrastructure/database';

import type { BEARER_TOKEN_TYPE } from '../../common/constants/auth.constants';

export type AuthTokenType = 'access' | 'refresh';

export interface TokenUser {
  id: string;
  email: string;
  role: SystemRole;
  tokenVersion: number;
}

export interface AuthTokenPayload {
  sub: string;
  email: string;
  role: SystemRole;
  tokenVersion: number;
  tokenType: AuthTokenType;
  sid: string;
  jti: string;
  v: 2;
  iat: number;
  exp?: number;
}

export interface AuthTokenPair {
  refreshTokenExpiresAt: Date;
  accessToken: string;
  refreshToken: string;
  tokenType: typeof BEARER_TOKEN_TYPE;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
}

export interface AuthenticatedUser {
  familyId: string;
  id: string;
  email: string;
  role: SystemRole;
  tokenVersion: number;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}
