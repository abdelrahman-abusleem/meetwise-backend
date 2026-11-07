const assert = require('node:assert/strict');
const path = require('node:path');
const [scenario, entry] = process.argv.slice(2);
const yaml = require(path.join(__dirname, '../../..', entry));
const schema = yaml.YAML11_SCHEMA || yaml.DEFAULT_SCHEMA;

if (scenario === 'empty-merge-budget') {
  const source =
    'arr: &arr [' +
    Array(30).fill('{}').join(',') +
    ']\ntargets:\n' +
    '  - <<: *arr\n'.repeat(10);
  assert.throws(
    () => yaml.load(source, { schema, maxTotalMergeKeys: 100 }),
    /merge/i,
  );
  assert.doesNotThrow(() =>
    yaml.load('base: &b {one: 1}\ncopy: {<<: *b}', {
      schema,
      maxTotalMergeKeys: 100,
    }),
  );
} else if (scenario === 'ordered-map') {
  const size = 40000;
  const source =
    '!!omap\n' +
    Array.from({ length: size }, (_, i) => `- key${i}: ${i}\n`).join('');
  const parsed = yaml.load(source, { schema });
  assert.equal(parsed.length, size);
  assert.deepEqual(parsed[size - 1], { key39999: 39999 });
} else {
  throw new Error('Unknown bounded YAML scenario');
}
