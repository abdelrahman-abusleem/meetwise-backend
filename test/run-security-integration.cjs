const { spawnSync } = require('node:child_process');
const { runBounded } = require('./bounded-process.cjs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const label = `mw-reset-test-${randomUUID()}`;
const redisImage =
  'redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';
let containerId;
let creationAttempted = false;

function docker(args, allowFailure = false) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  if (result.status !== 0 && !allowFailure)
    throw new Error(`Docker ${args[0]} failed; disposable Redis is required`);
  return { status: result.status, output: (result.stdout || '').trim() };
}

async function run() {
  try {
    creationAttempted = true;
    containerId = docker([
      'run',
      '-d',
      '--name',
      label,
      '--label',
      `meetwise.security-test=${label}`,
      '--memory',
      '128m',
      '--cpus',
      '1',
      '--tmpfs',
      '/data:rw',
      '-p',
      '127.0.0.1::6379',
      redisImage,
    ]).output;
    const info = JSON.parse(docker(['inspect', containerId]).output)[0];
    const binding = info.NetworkSettings.Ports['6379/tcp'][0];
    if (binding.HostIp !== '127.0.0.1')
      throw new Error('Fixture must bind only to loopback');
    const deadline = Date.now() + 20000;
    while (
      docker(['exec', containerId, 'redis-cli', 'ping'], true).output !== 'PONG'
    ) {
      if (Date.now() > deadline)
        throw new Error('Disposable Redis readiness timed out');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const result = await runBounded(
      process.execPath,
      [
        path.join(root, 'node_modules/jest/bin/jest.js'),
        '--config',
        path.join(root, 'test/jest-security-integration.cjs'),
        '--runInBand',
        '--no-cache',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          MEETWISE_RESET_TEST_REDIS_PORT: binding.HostPort,
        },
        stdio: 'inherit',
        windowsHide: true,
        timeout: 120000,
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
      error instanceof Error
        ? error.message
        : 'Security integration fixture failed',
    );
    process.exitCode = 1;
  } finally {
    if (creationAttempted) {
      try {
        const owned = JSON.parse(
          docker(['inspect', containerId || label]).output,
        )[0];
        if (owned.Config.Labels['meetwise.security-test'] !== label)
          throw new Error('Fixture ownership mismatch; refusing cleanup');
        docker(['rm', '-f', containerId || label]);
        console.log('Disposable security-test Redis removed.');
      } catch {
        console.error(
          `Disposable fixture cleanup failed; inspect the security-test label ${label}.`,
        );
        process.exitCode = 1;
      }
    }
  }
}

void run();
