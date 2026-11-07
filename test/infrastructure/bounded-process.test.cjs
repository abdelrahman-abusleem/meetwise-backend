const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { runBounded } = require('../bounded-process.cjs');

const execute = (source, options = {}) =>
  runBounded(process.execPath, ['-e', source], {
    timeout: 4000,
    ...options,
  });
test('captures successful stdout/stderr and preserves nonzero exit', async () => {
  const ok = await execute('console.log("ok");console.error("diagnostic")');
  assert.equal(ok.status, 0);
  assert.equal(ok.error, undefined);
  assert.equal(ok.stdout.trim(), 'ok');
  assert.equal(ok.stderr.trim(), 'diagnostic');
  const failed = await execute('process.exit(7)');
  assert.equal(failed.status, 7);
  assert.equal(failed.error, undefined);
});
test('missing executable is a startup failure, not a timeout', async () => {
  const r = await runBounded(path.join(os.tmpdir(), 'mw-no-such-command'), [], {
    timeout: 3000,
  });
  assert.equal(r.error.code, 'ENOENT');
  assert.equal(r.status, null);
});
test('hard deadline remains bounded even when child handles SIGTERM', async () => {
  const start = Date.now();
  const r = await execute(
    'process.on("SIGTERM",()=>{});setTimeout(()=>{},8000)',
    { timeout: 1500 },
  );
  assert.equal(r.error.code, 'ETIMEDOUT');
  assert.equal(r.status, null);
  assert(Date.now() - start < 5000);
  assert.equal(r.cleanupError, undefined);
});
test('output overflow is bounded and classified separately', async () => {
  const r = await execute(
    'process.stdout.write("x".repeat(100000));setTimeout(()=>{},8000)',
    { maxBuffer: 1000 },
  );
  assert.equal(r.error.code, 'ENOBUFS');
  assert.equal(r.status, null);
  assert(r.stdout.length <= 1000);
  assert.equal(r.cleanupError, undefined);
});
test('rejects missing, zero, negative and overflowing execution bounds', async () => {
  for (const timeout of [undefined, 0, -1, Infinity, 2147483648])
    await assert.rejects(execute('', { timeout }), RangeError);
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false;
    }
    return true;
  } catch (e) {
    if (e.code === 'ESRCH' || e.code === 'ENOENT') return false;
    throw e;
  }
}
for (const mode of ['timeout', 'complete'])
  test(`real owned tree ${mode} removes both descendants and preserves unrelated sentinel`, async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-bounded-tree-'));
    const fixture = path.join(__dirname, 'fixtures/owned-tree.cjs');
    const sentinel = spawn(process.execPath, [fixture, 'sentinel', folder], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const sentinelClosed = once(sentinel, 'close');
    let descendants = [];
    try {
      const r = await runBounded(
        process.execPath,
        [fixture, 'root', folder, mode],
        { timeout: mode === 'timeout' ? 1500 : 4000 },
      );
      descendants = ['branch', 'leaf'].map((role) =>
        Number(fs.readFileSync(path.join(folder, `${role}.pid`), 'utf8')),
      );
      assert.equal(r.status, mode === 'timeout' ? null : 0);
      assert.equal(r.error?.code, mode === 'timeout' ? 'ETIMEDOUT' : undefined);
      const deadline = Date.now() + 1000;
      while (descendants.some(alive) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert(
        descendants.every((pid) => !alive(pid)),
        'Owned descendant survived termination',
      );
      assert(alive(sentinel.pid), 'Unrelated sentinel was terminated');
      assert.equal(r.cleanupError, undefined);
    } finally {
      sentinel.kill('SIGKILL');
      await sentinelClosed;
      const deadline = Date.now() + 9000;
      while (descendants.some(alive) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert(
        descendants.every((pid) => !alive(pid)),
        'Owned self-expiring fixture remains',
      );
      fs.rmSync(folder, { recursive: true });
    }
  });
