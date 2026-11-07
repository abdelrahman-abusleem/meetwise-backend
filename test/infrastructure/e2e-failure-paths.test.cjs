const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { migrate } = require('../fixtures/migration-process.cjs');
const budgets = require('../e2e-budgets.cjs');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-final-p2-tests-'));
after(() => {
  assert.equal(path.dirname(folder), os.tmpdir());
  fs.rmSync(folder, { recursive: true });
});
const datasource = new URL('postgresql://synthetic@127.0.0.1:1/unused');
test('setup and runner budgets enclose three complete migration subprocess bounds', () => {
  assert.ok(
    budgets.SESSION_SETUP_TIMEOUT_MS >= 3 * budgets.MIGRATE_TIMEOUT_MS + 90000,
  );
  assert.ok(budgets.JEST_MAX_BUDGET_MS > budgets.SESSION_SETUP_TIMEOUT_MS);
});
test('migration adapter accepts a bounded slow successful child and records output', async () => {
  const log = path.join(folder, 'success.log');
  await migrate(
    folder,
    datasource,
    log,
    undefined,
    (_command, _args, options) => {
      assert.equal(options.timeout, 120000);
      return spawnSync(
        process.execPath,
        ['-e', 'setTimeout(()=>console.log("synthetic completed"),30)'],
        { encoding: 'utf8', timeout: 1000, windowsHide: true },
      );
    },
  );
  assert.match(fs.readFileSync(log, 'utf8'), /synthetic completed/);
});
test('migration adapter rejects actual child timeout as infrastructure failure and preserves log', async () => {
  const log = path.join(folder, 'timeout.log');
  await assert.rejects(
    () =>
      migrate(folder, datasource, log, undefined, () =>
        spawnSync(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
          encoding: 'utf8',
          timeout: 50,
          windowsHide: true,
        }),
      ),
    new RegExp('infrastructure/process timeout'),
  );
  assert.ok(fs.existsSync(log));
});
test('migration adapter distinguishes nonzero and signal exits from success', async () => {
  for (const result of [
    { status: 1, stdout: 'failure' },
    { status: null, signal: 'SIGTERM' },
  ])
    await assert.rejects(
      () =>
        migrate(
          folder,
          datasource,
          path.join(folder, 'failure.log'),
          undefined,
          () => result,
        ),
      /migration failed/,
    );
});
async function runner(outcome, cleanupFailure = false) {
  const filename = path.resolve(__dirname, '../run-e2e.cjs'),
    load = createRequire(filename);
  const containers = new Map(),
    removed = [],
    messages = [];
  function execute(command, args, options) {
    if (command !== 'docker') {
      assert.equal(options.timeout, 600000);
      return outcome;
    }
    if (args[0] === 'run') {
      const name = args[args.indexOf('--name') + 1],
        label = args[args.indexOf('--label') + 1].split('=')[1];
      const port = name.endsWith('postgres') ? '5432/tcp' : '6379/tcp';
      containers.set(name, {
        Config: { Labels: { 'meetwise.e2e-test': label } },
        NetworkSettings: {
          Ports: { [port]: [{ HostIp: '127.0.0.1', HostPort: '54321' }] },
        },
      });
      return { status: 0, stdout: 'synthetic-container' };
    }
    if (args[0] === 'inspect')
      return { status: 0, stdout: JSON.stringify([containers.get(args[1])]) };
    if (args[0] === 'exec')
      return { status: 0, stdout: 'accepting connections PONG' };
    if (args[0] === 'rm') {
      if (cleanupFailure && removed.length === 0) {
        cleanupFailure = false;
        return { status: 1, stdout: '' };
      }
      removed.push(args.at(-1));
      containers.delete(args.at(-1));
      return { status: 0, stdout: '' };
    }
    throw new Error('Unexpected mocked Docker operation');
  }
  const context = {
    require: (name) =>
      name === 'node:child_process'
        ? { spawnSync: execute }
        : name === './bounded-process.cjs'
          ? { runBounded: execute }
          : load(name),
    __dirname: path.dirname(filename),
    process: {
      ...process,
      argv: ['node', filename],
      env: {},
      exitCode: undefined,
    },
    console: { log: (s) => messages.push(s), error: (s) => messages.push(s) },
    setTimeout,
  };
  vm.runInNewContext(
    fs
      .readFileSync(filename, 'utf8')
      .replace('void run();', 'globalThis.done=run();'),
    context,
    { filename },
  );
  await context.done;
  return {
    code: context.process.exitCode,
    removed,
    remaining: containers.size,
    messages,
  };
}
test('Jest timeout produces failure and removes both owned fixtures', async () => {
  const r = await runner({
    status: null,
    error: { code: 'ETIMEDOUT', message: 'synthetic timeout' },
  });
  assert.equal(r.code, 1);
  assert.equal(r.removed.length, 2);
  assert.equal(r.remaining, 0);
  assert.ok(r.messages.some((s) => s.includes('runner timeout')));
});
test('ordinary Jest failure also cleans both fixtures', async () => {
  const r = await runner({ status: 1 });
  assert.equal(r.code, 1);
  assert.equal(r.remaining, 0);
});
test('cleanup failure cannot turn passing Jest into a success', async () => {
  const r = await runner({ status: 0 }, true);
  assert.equal(r.code, 1);
  assert.equal(r.remaining, 1);
});

test('Jest startup failure is not mislabeled as a timeout and still cleans fixtures', async () => {
  const r = await runner({ status: null, error: { code: 'ENOENT' } });
  assert.equal(r.code, 1);
  assert.equal(r.remaining, 0);
  assert(r.messages.some((s) => s.includes('infrastructure failure (ENOENT)')));
  assert(!r.messages.some((s) => s.includes('runner timeout')));
});
test('migration startup failure has distinct infrastructure diagnostics', async () => {
  await assert.rejects(
    () =>
      migrate(
        folder,
        datasource,
        path.join(folder, 'missing.log'),
        undefined,
        () => ({ status: null, error: { code: 'ENOENT' } }),
      ),
    /infrastructure failure \(ENOENT\)/,
  );
});
