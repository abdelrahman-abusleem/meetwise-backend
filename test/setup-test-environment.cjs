const { randomBytes } = require('node:crypto');

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:unused@127.0.0.1:1/meetwise_test',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: process.env.MEETWISE_RESET_TEST_REDIS_PORT || '1',
  JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
  JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
  PASSWORD_RESET_SECRET: randomBytes(48).toString('hex'),
  PASSWORD_RESET_TTL_SECONDS: '300',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1',
  SMTP_FROM: 'tests@example.invalid',
  SMTP_USER: '',
  SMTP_PASSWORD: '',
  WEB_APP_URL: 'http://127.0.0.1:1',
});
