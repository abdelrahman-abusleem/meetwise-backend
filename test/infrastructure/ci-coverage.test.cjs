const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '../..');
const workflow = yaml.load(
  fs.readFileSync(path.join(root, '.github/workflows/quality.yml'), 'utf8'),
);
const step = workflow.jobs.quality.steps.find(
  (value) => value.name === 'Run check',
);
const body = step.run.match(/^\s*unit\)\s*([\s\S]*?);;/m)?.[1];
assert(body, 'unit branch must exist');
const bash =
  process.platform === 'win32'
    ? 'C:/Program Files/Git/bin/bash.exe'
    : '/bin/bash';
const unixPath = (value) =>
  process.platform === 'win32'
    ? value
        .replaceAll('\\', '/')
        .replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase())
    : value;
const expected = [
  'npm test -- --runInBand --no-cache',
  'node --test test/infrastructure/',
  'node scripts/validate_openapi.cjs contracts/openapi.yaml',
  'python3 -B -m unittest discover -s scripts -p test_s1_quality_*.py -v',
  'python3 -B -m unittest discover -s deploy/s1 -p test_toolkit.py -v',
];

function simulate(failureAt = 0) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-ci-coverage-'));
  try {
    const log = path.join(directory, 'commands.log');
    for (const command of ['npm', 'node', 'python3']) {
      fs.writeFileSync(
        path.join(directory, command),
        '#!/bin/sh\nprintf "%s\\n" "' +
          command +
          ' $*" >> "$CI_TRACE"\ncount=$(wc -l < "$CI_TRACE")\nif [ "$count" -eq "$CI_FAIL_AT" ]; then exit 42; fi\n',
        { mode: 0o700 },
      );
    }
    const result = spawnSync(
      bash,
      [
        '--noprofile',
        '--norc',
        '-eo',
        'pipefail',
        '-c',
        'export PATH="$CI_STUBS:/usr/bin:/bin"\n' + body,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
        env: {
          ...process.env,
          CI_STUBS: unixPath(directory),
          CI_TRACE: unixPath(log),
          CI_FAIL_AT: String(failureAt),
        },
      },
    );
    assert.ifError(result.error);
    const commands = fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').trim().split(/\r?\n/)
      : [];
    return { status: result.status, commands, stderr: result.stderr };
  } finally {
    assert(path.basename(directory).startsWith('mw-ci-coverage-'));
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true });
  }
}

test('required contexts and readonly workflow identity remain intact', () => {
  assert.deepEqual(workflow.jobs.quality.strategy.matrix.check, [
    'build',
    'typecheck',
    'lint',
    'unit',
    'e2e',
    'security',
  ]);
  assert.equal(workflow.jobs.quality.name, 'mw/${{ matrix.check }}');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.quality['continue-on-error'], undefined);
  for (const action of workflow.jobs.quality.steps.filter(
    (value) => value.uses,
  )) {
    assert.match(action.uses, /^actions\/(checkout|setup-node)@[a-f0-9]{40}$/);
    assert.equal(action['continue-on-error'], undefined);
  }
});
test('unit lane actually invokes all five gates in order', () => {
  const result = simulate();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.commands.length, 5);
  for (let index = 0; index < expected.length; index++)
    assert(
      result.commands[index].startsWith(expected[index]),
      result.commands[index],
    );
});
for (let failureAt = 1; failureAt <= 5; failureAt++) {
  test(`unit lane stops when gate ${failureAt} fails`, () => {
    const result = simulate(failureAt);
    assert.equal(result.status, 42, result.stderr);
    assert.equal(result.commands.length, failureAt);
  });
}
test('full Run check shell parses without executing any lane', () => {
  const result = spawnSync(bash, ['--noprofile', '--norc', '-n'], {
    input: step.run,
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
