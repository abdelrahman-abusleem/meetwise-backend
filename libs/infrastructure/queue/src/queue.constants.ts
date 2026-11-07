export const QUEUE_NAMES = {
  TRANSCRIPT: 'transcript',
  SYSTEM: 'system',
  AUTH: 'auth',
} as const;

export const SYSTEM_JOB_NAMES = {
  SMOKE_TEST: 'smoke-test',
} as const;

export const AUTH_JOB_NAMES = {
  SEND_PASSWORD_RESET_EMAIL: 'send-password-reset-email',
} as const;
