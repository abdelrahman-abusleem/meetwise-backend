const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const uri = require('fast-uri');

const root = path.resolve(__dirname, '../..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
const instances = Object.keys(lock.packages).filter((entry) =>
  entry.endsWith('/js-yaml'),
);
assert(instances.length > 0);
for (const entry of instances) {
  const yaml = require(path.join(root, entry));
  const schema = yaml.YAML11_SCHEMA || yaml.DEFAULT_SCHEMA;
  test(`normal YAML and ordered-map uniqueness: ${entry}`, () => {
    assert.deepEqual(yaml.load('name: MeetWise\nitems: [one, two]'), {
      name: 'MeetWise',
      items: ['one', 'two'],
    });
    assert.deepEqual(yaml.load('!!omap\n- one: 1\n- two: 2', { schema }), [
      { one: 1 },
      { two: 2 },
    ]);
    assert.throws(() => yaml.load('!!omap\n- one: 1\n- one: 2', { schema }));
  });
  for (const scenario of ['empty-merge-budget', 'ordered-map']) {
    test(`${scenario} stays bounded: ${entry}`, () => {
      const result = spawnSync(
        process.execPath,
        [
          '--max-old-space-size=96',
          path.join(__dirname, 'fixtures/yaml-uri-advisory-worker.cjs'),
          scenario,
          entry,
        ],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 6000,
          maxBuffer: 16000,
        },
      );
      assert.equal(
        result.status,
        0,
        `${scenario}: ${result.error?.code || result.signal || result.status} ${(result.stderr || '').slice(0, 250)}`,
      );
    });
  }
}

const components = { scheme: 'http', host: 'trusted.example', path: '/app' };
for (const operation of ['serialize', 'normalize']) {
  test('URI ' + operation + ' rejects authority injection via port', () => {
    assert.throws(() =>
      uri[operation]({ ...components, port: '@127.0.0.1:8124' }),
    );
  });
}
test('URI equality cannot equate injected authority to its destination', () => {
  const input = { ...components, port: '@127.0.0.1:8124' };
  assert.equal(
    uri.equal(input, 'http://trusted.example:@127.0.0.1:8124/app'),
    false,
  );
});
test('URI valid numeric port and ordinary resolution remain usable', () => {
  const serialized = uri.serialize({ ...components, port: 8080 });
  assert.equal(new URL(serialized).host, 'trusted.example:8080');
  assert.equal(
    uri.resolve('https://example.test/base/', '../safe'),
    'https://example.test/safe',
  );
});
test('URI percent-encoded uppercase host canonicalization agrees', () => {
  assert.equal(uri.parse('//%41.com').host, 'a.com');
  assert.equal(uri.equal('//%41.com', '//a.com'), true);
});
const ajvCallers = Object.entries(lock.packages).filter(
  ([entry, metadata]) =>
    entry.endsWith('/ajv') && metadata.dependencies?.['fast-uri'],
);
assert(ajvCallers.length > 0, 'No actual AJV fast-uri caller found');
for (const [entry] of ajvCallers) {
  test('actual fast-uri caller resolves schema references: ' + entry, () => {
    const callerPath = path.join(root, entry);
    const resolvedUri = require(
      require.resolve('fast-uri', { paths: [callerPath] }),
    );
    assert.equal(
      resolvedUri,
      uri,
      'Caller must use the patched installed parser',
    );
    const Ajv = require(callerPath);
    const ajv = new Ajv();
    ajv.addSchema({
      $id: 'https://example.test/defs/value.json',
      type: 'integer',
      minimum: 1,
    });
    const validate = ajv.compile({
      $id: 'https://example.test/app.json',
      $ref: './defs/value.json',
    });
    assert.equal(validate(2), true);
    assert.equal(validate(0), false);
    assert.equal(validate('2'), false);
  });
}
