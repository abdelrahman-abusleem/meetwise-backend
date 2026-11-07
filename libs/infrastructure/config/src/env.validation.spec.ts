import 'reflect-metadata';
import { validateEnvironment } from './env.validation';

describe('Environment validation after product-license removal', () => {
  const valid = () => ({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://synthetic@127.0.0.1:1/unused',
    JWT_ACCESS_SECRET: 'synthetic-access-secret-for-config-validation',
    JWT_REFRESH_SECRET: 'synthetic-refresh-secret-for-config-validation',
    PASSWORD_RESET_SECRET: 'synthetic-reset-secret-for-config-validation',
    PASSWORD_RESET_TTL_SECONDS: '300',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1',
    SMTP_FROM: 'tests@example.invalid',
    WEB_APP_URL: 'http://127.0.0.1:1',
  });

  it('validates startup configuration without a license key path', () => {
    const result = validateEnvironment(valid());
    expect(Object.hasOwn(result, 'LICENSE_PUBLIC_KEY_PATH')).toBe(false);
    expect(result.JWT_ACCESS_TTL_SECONDS).toBe(900);
    expect(result.JWT_REFRESH_TTL_SECONDS).toBe(604_800);
  });

  it('still rejects a missing access-token secret', () => {
    expect(() =>
      validateEnvironment({ ...valid(), JWT_ACCESS_SECRET: undefined }),
    ).toThrow();
  });

  it('still requires independent access and refresh secrets', () => {
    const config = valid();
    expect(() =>
      validateEnvironment({
        ...config,
        JWT_REFRESH_SECRET: config.JWT_ACCESS_SECRET,
      }),
    ).toThrow('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different');
  });

  it('still requires an independent password-reset secret', () => {
    const config = valid();
    expect(() =>
      validateEnvironment({
        ...config,
        PASSWORD_RESET_SECRET: config.JWT_ACCESS_SECRET,
      }),
    ).toThrow('PASSWORD_RESET_SECRET must be different from JWT secrets');
  });

  it('still rejects unsupported database URLs', () => {
    expect(() =>
      validateEnvironment({
        ...valid(),
        DATABASE_URL: 'https://example.invalid',
      }),
    ).toThrow();
  });

  it('still requires paired SMTP credentials', () => {
    expect(() =>
      validateEnvironment({ ...valid(), SMTP_USER: 'synthetic' }),
    ).toThrow('SMTP_USER and SMTP_PASSWORD must be configured together');
  });
});
