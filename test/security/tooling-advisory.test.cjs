const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const browserslist = require('browserslist');

const root = path.resolve(__dirname, '../..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
const instances = Object.entries(lock.packages).filter(([entry]) =>
  entry.endsWith('/brace-expansion'),
);
assert(instances.length > 0);
const representatives = new Map();
for (const [entry, metadata] of instances) {
  test(`normal expansion through ${entry}`, () => {
    const loaded = require(path.join(root, entry));
    const expand =
      typeof loaded === 'function' ? loaded : loaded.expand || loaded.default;
    assert.deepEqual(expand('file-{a,b}{1..2}.ts'), [
      'file-a1.ts',
      'file-a2.ts',
      'file-b1.ts',
      'file-b2.ts',
    ]);
  });
  representatives.set(metadata.version, entry);
}

function runBounded(scenario, entry = '') {
  const result = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=96',
      path.join(__dirname, 'fixtures/tooling-advisory-worker.cjs'),
      scenario,
      entry,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: scenario === 'browser-cache' ? 20000 : 6000,
      maxBuffer: 32000,
    },
  );
  assert.equal(
    result.status,
    0,
    `${scenario} failed (${result.error?.code || result.signal || result.status}): ${(result.stderr || '').slice(0, 300)}`,
  );
}
for (const [version, entry] of representatives) {
  for (const scenario of [
    'brace-length',
    'brace-intermediate',
    'brace-nested',
    'brace-comma',
    'brace-rewrite',
  ]) {
    test(`${scenario} stays bounded in installed brace-expansion${version}`, () =>
      runBounded(scenario, entry));
  }
}

for (const key of [
  '__proto__',
  'toString',
  'valueOf',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
]) {
  test(`Browserslist handles custom stats key ${key} without crashing`, () => {
    const stats = JSON.parse(`{"${key}":{"onekey":5},"chrome":{"100":50}}`);
    assert.doesNotThrow(() => browserslist('defaults', { stats }));
    assert.equal({}.onekey, undefined);
  });
}
test('Browserslist preserves ordinary query results', () => {
  assert.deepEqual(browserslist('chrome 100'), ['chrome 100']);
});
for (const scenario of [
  'browser-cache',
  'baseline-conflict',
  'baseline-kaios',
  'baseline-normal',
]) {
  test(`bounded tooling fixture: ${scenario}`, () => runBounded(scenario));
}
