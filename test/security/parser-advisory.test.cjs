const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const adapterRequire = createRequire(
  require.resolve('@nestjs/platform-express'),
);
const expressRequire = createRequire(adapterRequire.resolve('express'));
const qs = expressRequire('qs');

for (const key of ['a', 'a[]']) {
  test(`qs enforces comma array limits for ${key}`, () => {
    assert.throws(
      () =>
        qs.parse(`${key}=1,2,3,4`, {
          comma: true,
          arrayLimit: 3,
          throwOnLimitExceeded: true,
        }),
      RangeError,
    );
  });
}
for (const options of [{ plainObjects: true }, { allowPrototypes: true }]) {
  test(`qs safely roundtrips hostile isBuffer data with ${Object.keys(options)[0]}`, () => {
    const parsed = qs.parse('a[constructor][isBuffer]=not-callable', options);
    assert.doesNotThrow(() => qs.stringify(parsed));
    assert.equal({}.isBuffer, undefined);
  });
}
test('qs preserves normal arrays and escaped text', () => {
  assert.deepEqual(qs.parse('name=%3Cguest%3E&values[]=one&values[]=two'), {
    name: '<guest>',
    values: ['one', 'two'],
  });
});
test('qs accepts comma arrays within the configured limit', () => {
  const result = qs.parse('a[]=1,2,3', {
    comma: true,
    arrayLimit: 3,
    throwOnLimitExceeded: true,
  });
  assert.deepEqual(result.a.flat(), ['1', '2', '3']);
});

const fixtureRoot = path.resolve(__dirname, '../../.tmp/parser-tests');
for (const scenario of [
  'fields',
  'arrays',
  'file',
  'unexpected-file',
  'async-limit',
  'oversized-index',
  'crafted-index',
  'truncated',
  'abort-disk',
  'abort-delayed-disk',
  'urlencoded',
  'nest-unexpected-file',
]) {
  test(`bounded real parser fixture: ${scenario}`, () => {
    fs.mkdirSync(fixtureRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(fixtureRoot, 'case-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          '--max-old-space-size=96',
          path.join(__dirname, 'fixtures/parser-advisory-worker.cjs'),
          scenario,
          directory,
        ],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 7000,
          maxBuffer: 64000,
        },
      );
      assert.equal(
        result.status,
        0,
        `${scenario} failed (${result.error?.code || result.signal || result.status}): ${result.stderr}`,
      );
    } finally {
      const resolved = fs.realpathSync(directory);
      assert.equal(path.dirname(resolved), fs.realpathSync(fixtureRoot));
      assert.match(path.basename(resolved), /^case-[a-zA-Z0-9]+$/);
      fs.rmSync(resolved, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });
}
