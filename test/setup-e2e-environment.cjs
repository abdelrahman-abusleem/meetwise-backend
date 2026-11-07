const path = require('node:path');

function fixturePort(name) {
  const value = process.env[name];
  if (!value || !/^\d+$/.test(value))
    throw new Error(
      'Run npm run test:e2e with its disposable service fixtures',
    );
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Invalid disposable E2E fixture port');
  return port;
}

const postgresPort = fixturePort('MEETWISE_E2E_PG_PORT');
const redisPort = fixturePort('MEETWISE_E2E_REDIS_PORT');
require('./setup-test-environment.cjs');
Object.assign(process.env, {
  DATABASE_URL: `postgresql://postgres@127.0.0.1:${postgresPort}/meetwise_e2e`,
  REDIS_PORT: String(redisPort),
  LICENSE_PUBLIC_KEY_PATH: path.resolve(
    __dirname,
    '../deployment/license/license-public.pem',
  ),
});
