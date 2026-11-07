const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

for (const operation of [
  'deepmerge',
  'deepmergeCustom',
  'deepmergeInto',
  'deepmergeIntoCustom',
]) {
  test(`recursive graph is bounded through ${operation}`, () => {
    const result = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=96',
        path.join(__dirname, 'fixtures/prisma-advisory-worker.cjs'),
        operation,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 16000,
      },
    );
    assert.equal(
      result.status,
      0,
      `${operation}: ${result.error?.code || result.signal || result.status} ${(result.stderr || '').slice(0, 240)}`,
    );
  });
}

test('ordinary deepmerge configuration composition remains usable', () => {
  const { deepmerge } = require('deepmerge-ts');
  assert.deepEqual(
    deepmerge(
      { migrations: { path: 'prisma/migrations' }, flags: ['one'] },
      { migrations: { shadow: false }, flags: ['two'] },
    ),
    {
      migrations: { path: 'prisma/migrations', shadow: false },
      flags: ['one', 'two'],
    },
  );
});

test('MySQL auth-switch cannot send a clear password over an insecure transport', async () => {
  const mysqlRoot = path.dirname(require.resolve('mysql2/package.json'));
  const AuthSwitchRequest = require(
    path.join(mysqlRoot, 'lib/packets/auth_switch_request.js'),
  );
  const { authSwitchRequest } = require(
    path.join(mysqlRoot, 'lib/commands/auth_switch.js'),
  );
  const request = new AuthSwitchRequest({
    pluginName: 'mysql_clear_password',
    pluginData: Buffer.alloc(0),
  }).toPacket();
  request.offset = 4;
  const writes = [];
  const errors = [];
  const command = new EventEmitter();
  command.on('error', (error) => errors.push(error));
  const connection = {
    config: { password: 'synthetic-not-a-credential', authPlugins: {} },
    stream: { encrypted: false },
    writePacket: (packet) => writes.push(packet),
  };
  try {
    authSwitchRequest(request, connection, command);
  } catch (error) {
    errors.push(error);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 0, 'Must not emit a credential response');
  assert.equal(
    errors.length,
    1,
    'Must explicitly reject the insecure auth switch',
  );
  assert.match(errors[0].message, /plugin|secure|tls|ssl|clear.?password/i);
});
