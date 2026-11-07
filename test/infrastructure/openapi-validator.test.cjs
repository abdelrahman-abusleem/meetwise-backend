const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const filename = path.resolve(__dirname, '../../scripts/validate_openapi.cjs');
const source = fs
  .readFileSync(filename, 'utf8')
  .replace(/^#!.*\n/, '')
  .replace('void main();', '');
const context = {
  require,
  module: { exports: {} },
  __dirname: path.dirname(filename),
  process,
  console,
};
vm.runInNewContext(source + '\nglobalThis.check = validateDocument;', context, {
  filename,
});
function problems(override) {
  const doc = {
    openapi: '3.1.0',
    info: { title: 'Test', version: '1' },
    paths: {
      '/test': {
        get: { operationId: 'test', responses: { 200: { description: 'OK' } } },
      },
    },
    ...override,
  };
  const errors = [];
  context.check('in-memory', doc, errors);
  return errors;
}
test('rejects unsupported OpenAPI minor versions', () => {
  assert.ok(problems({ openapi: '3.99.0' }).length);
});
test('rejects malformed and inherited-property references', () => {
  for (const ref of [123, null, '#/__proto__/constructor'])
    assert.ok(
      problems({ components: { schemas: { Probe: { $ref: ref } } } }).length,
    );
});
test('rejects invalid response codes', () => {
  assert.ok(
    problems({
      paths: {
        '/test': {
          get: {
            operationId: 'test',
            responses: { banana: { description: 'invalid' } },
          },
        },
      },
    }).length,
  );
});
test('accepts supported versions and concrete response codes', () => {
  for (const openapi of ['3.0.3', '3.1.0'])
    assert.deepEqual(problems({ openapi }), []);
});
