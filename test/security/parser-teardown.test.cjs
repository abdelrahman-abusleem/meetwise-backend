const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

for (const scenario of [
  'deflate-control',
  'deflate-late',
  'unsupported-charset',
  'decoder-late-error',
  'upload-late-filter',
]) {
  test('bounded process survives parser teardown: ' + scenario, () => {
    const result = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=96',
        path.join(__dirname, 'fixtures/parser-teardown-worker.cjs'),
        scenario,
      ],
      { timeout: 5000, maxBuffer: 64000, windowsHide: true, encoding: 'utf8' },
    );
    assert.equal(
      result.status,
      0,
      `${scenario}: ${result.error?.code || result.signal || result.status}\n${result.stderr}`,
    );
    assert.match(
      result.stdout,
      new RegExp('PARSER_TEARDOWN_FIXTURE_OK ' + scenario),
    );
  });
}
