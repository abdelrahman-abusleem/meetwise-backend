const { JEST_MAX_BUDGET_MS } = require('./e2e-budgets.cjs');
const { spawnSync } = require('node:child_process');
const { runBounded } = require('./bounded-process.cjs');
const { randomUUID } = require('node:crypto');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const runId = `mw-e2e-${randomUUID()}`;
const ownedFixtures = [];

const BASE_BUDGET_MS = 60_000;
const PER_SUITE_BUDGET_MS = 150_000;
const MAX_BUDGET_MS = JEST_MAX_BUDGET_MS;

function e2eSuiteCount() {
  return readdirSync(path.join(root, 'apps/api/test')).filter((name) =>
    name.endsWith('.e2e-spec.ts'),
  ).length;
}

function jestBudgetMs(suiteCount) {
  if (suiteCount < 1) throw new Error('No E2E suites to run');
  return Math.min(
    Math.max(
      require('./e2e-budgets.cjs').SESSION_SETUP_TIMEOUT_MS + 30_000,
      BASE_BUDGET_MS + PER_SUITE_BUDGET_MS * suiteCount,
    ),
    MAX_BUDGET_MS,
  );
}

const images = {
  postgres:
    'postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3',
  redis:
    'redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499',
};

function docker(args, allowFailure = false) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  if (result.status !== 0 && !allowFailure)
    throw new Error(
      `Docker ${args[0]} failed; disposable E2E services are required`,
    );
  return { status: result.status, output: (result.stdout || '').trim() };
}

function startFixture(kind, port, extra) {
  const name = `${runId}-${kind}`;
  ownedFixtures.push(name);
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    `meetwise.e2e-test=${runId}`,
    '--memory',
    '384m',
    '--cpus',
    '1',
    '-p',
    `127.0.0.1::${port}`,
    ...extra,
    images[kind],
  ]);
  const info = JSON.parse(docker(['inspect', name]).output)[0];
  const bindings = info.NetworkSettings.Ports[`${port}/tcp`];
  if (bindings.length !== 1 || bindings[0].HostIp !== '127.0.0.1')
    throw new Error('E2E fixture must bind only to loopback');
  return { name, port: bindings[0].HostPort };
}

async function waitForService(fixture, probe, expected) {
  const deadline = Date.now() + 30000;
  while (
    !docker(['exec', fixture.name, ...probe], true).output.includes(expected)
  ) {
    if (Date.now() > deadline)
      throw new Error('Disposable E2E service readiness timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function cleanupFixtures() {
  let cleaned = 0;
  for (const name of ownedFixtures.reverse()) {
    try {
      const inspected = docker(['inspect', name], true);
      if (inspected.status !== 0) {
        const existing = docker([
          'ps',
          '-a',
          '--filter',
          `name=^/${name}$`,
          '--format',
          '{{.Names}}',
        ]).output;
        if (!existing) continue;
        throw new Error('Cannot verify fixture ownership');
      }
      const info = JSON.parse(inspected.output)[0];
      if (info.Config.Labels['meetwise.e2e-test'] !== runId)
        throw new Error('Fixture ownership mismatch; refusing removal');
      docker(['rm', '-f', name]);
      cleaned += 1;
    } catch {
      console.error(
        `E2E fixture cleanup failed; inspect owned label ${runId}.`,
      );
      process.exitCode = 1;
    }
  }
  if (cleaned === ownedFixtures.length) {
    console.log(
      `Disposable E2E fixture cleanup completed; ${cleaned} owned fixtures removed; no cleanup failures.`,
    );
  } else {
    console.log(
      `Disposable E2E fixture cleanup completed with failures; inspect owned label ${runId}.`,
    );
  }
}

async function run() {
  try {
    const postgres = startFixture('postgres', 5432, [
      '--tmpfs',
      '/var/lib/postgresql/data:rw',
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      'POSTGRES_DB=meetwise_e2e',
    ]);
    const redis = startFixture('redis', 6379, ['--tmpfs', '/data:rw']);
    await waitForService(
      postgres,
      ['pg_isready', '-U', 'postgres'],
      'accepting connections',
    );
    await waitForService(redis, ['redis-cli', 'ping'], 'PONG');
    const result = await runBounded(
      process.execPath,
      [
        path.join(root, 'node_modules/jest/bin/jest.js'),
        '--config',
        path.join(root, 'apps/api/test/jest-e2e.json'),
        '--runInBand',
        ...process.argv.slice(2),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          MEETWISE_E2E_RUN_ID: runId,
          MEETWISE_E2E_PG_CONTAINER: postgres.name,
          MEETWISE_E2E_PG_PORT: postgres.port,
          MEETWISE_E2E_REDIS_PORT: redis.port,
        },
        stdio: 'inherit',
        windowsHide: true,
        timeout: jestBudgetMs(e2eSuiteCount()),
      },
    );
    if (result.error) {
      console.error(
        result.error.code === 'ETIMEDOUT'
          ? 'Test subprocess runner timeout; no completed test result verified.'
          : 'Test subprocess infrastructure failure (' +
              String(result.error.code || 'unknown') +
              '); no completed test result verified.',
      );
    }
    if (result.cleanupError)
      console.error(
        'Owned test subprocess cleanup failed (' +
          String(result.cleanupError.code || 'unknown') +
          ').',
      );
    process.exitCode = result.status === 0 ? 0 : 1;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'E2E fixture failed',
    );
    process.exitCode = 1;
  } finally {
    cleanupFixtures();
  }
}

void run();
