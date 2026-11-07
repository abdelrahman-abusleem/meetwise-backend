export const BEARER_TOKEN_TYPE = 'Bearer' as const;
export const INVALID_ACCESS_TOKEN = 'Invalid or expired access token';
export const INVALID_REFRESH_TOKEN = 'Invalid or expired refresh token';
export const INVALID_CREDENTIALS = 'Invalid credentials';
export const ACCOUNT_INACTIVE = 'User account is inactive';
export const ACCESS_TOKEN_COOKIE_NAME = 'meetwise_access_token';
export const REFRESH_TOKEN_COOKIE_NAME = 'meetwise_refresh_token';
export const AUTH_SESSION_KEY_PREFIX = 'auth:session';
export const AUTH_TOKEN_VERSION_KEY_PREFIX = 'auth:token-version';
export const AUTH_USER_ACTIVE_KEY_PREFIX = 'auth:user-active';
export const INVALID_CURRENT_PASSWORD = 'Current password is incorrect';
export const NEW_PASSWORD_MUST_BE_DIFFERENT =
  'New password must be different from the current password';
export const AUTH_STATE_CHANGED =
  'Authentication state changed. Please try again';
