const { runBounded } = require('../bounded-process.cjs');
const { writeFileSync } = require('node:fs');
const { MIGRATE_TIMEOUT_MS } = require('../e2e-budgets.cjs');
async function migrate(root, url, logPath, config, execute = runBounded) {
  const args = ['node_modules/prisma/build/index.js', 'migrate', 'deploy'];
  if (config) args.push('--config', config);
  const result = await execute(process.execPath, args, {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url.toString() },
    encoding: 'utf8',
    windowsHide: true,
    timeout: MIGRATE_TIMEOUT_MS,
  });
  writeFileSync(logPath, (result.stdout || '') + (result.stderr || ''));
  if (result.status === null && result.error?.code === 'ETIMEDOUT')
    throw new Error(
      'Disposable Prisma migration process did not finish (' +
        String(result.error.code || 'unknown') +
        '); infrastructure/process timeout, not a verified migration failure; inspect ' +
        logPath,
    );
  if (result.error)
    throw new Error(
      'Disposable Prisma migration process infrastructure failure (' +
        String(result.error.code || 'unknown') +
        '); inspect ' +
        logPath,
    );
  if (result.status !== 0)
    throw new Error(
      'Disposable Prisma migration failed with exit ' +
        String(result.status) +
        '; inspect fixture log ' +
        logPath,
    );
}
module.exports = { migrate };
