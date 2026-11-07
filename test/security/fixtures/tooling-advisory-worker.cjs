const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const scenario = process.argv[2];
const root = path.resolve(__dirname, '../../..');

if (scenario.startsWith('brace-')) {
  const entry = process.argv[3];
  const lock = JSON.parse(
    fs.readFileSync(path.join(root, 'package-lock.json')),
  );
  assert(
    entry.startsWith('node_modules/') &&
      entry.endsWith('/brace-expansion') &&
      lock.packages[entry],
  );
  const target = path.resolve(root, entry);
  assert(target.startsWith(path.join(root, 'node_modules') + path.sep));
  const loaded = require(target);
  const expand =
    typeof loaded === 'function' ? loaded : loaded.expand || loaded.default;
  let input,
    options = { max: 32, maxLength: 100000 };
  if (scenario === 'brace-length') {
    input = '{a,b}'.repeat(1000);
    options.maxLength = 4096;
  } else if (scenario === 'brace-intermediate') {
    input = '{' + Array(150).fill('{a,b}'.repeat(30)).join(',') + '}';
    options = { max: 4096, maxLength: 4096 };
  } else if (scenario === 'brace-nested')
    input = '{a,'.repeat(5000) + 'z' + '}'.repeat(5000);
  else if (scenario === 'brace-comma')
    input = '{' + '{a},'.repeat(10000) + 'b}';
  else if (scenario === 'brace-rewrite')
    input = '{a}' + '}'.repeat(64000) + ',z}';
  else throw new Error('Unknown brace fixture');
  const output = expand(input, options);
  assert(Array.isArray(output));
  assert(output.length <= options.max);
  if (scenario === 'brace-length' || scenario === 'brace-intermediate')
    assert(
      output.reduce((size, value) => size + value.length, 0) <=
        options.maxLength,
    );
} else if (scenario === 'browser-cache') {
  delete process.env.BROWSERSLIST_DISABLE_CACHE;
  const browserslist = require('browserslist');
  const query = 'since 1900-1-1';
  const original = browserslist(query);
  assert.strictEqual(browserslist(query), original);
  for (let day = 2; day <= 2002; day++) browserslist(`since 1900-1-${day}`);
  const after = browserslist(query);
  assert.deepEqual(after, original);
  assert.notStrictEqual(
    after,
    original,
    'Distinct query results must evict stale cached references',
  );
} else {
  const mapping = require('baseline-browser-mapping');
  if (scenario === 'baseline-conflict') {
    assert.throws(
      () =>
        mapping.getCompatibleVersions({
          targetYear: 2022,
          widelyAvailableOnDate: '2024-01-01',
          suppressWarnings: true,
        }),
      Error,
    );
  } else if (scenario === 'baseline-kaios') {
    assert.throws(
      () =>
        mapping.getAllVersions({
          includeKaiOS: true,
          includeDownstreamBrowsers: false,
          suppressWarnings: true,
        }),
      Error,
    );
  } else if (scenario === 'baseline-normal') {
    const result = mapping.getCompatibleVersions({
      targetYear: 2022,
      suppressWarnings: true,
    });
    assert(Array.isArray(result) && result.length > 0);
  } else throw new Error('Unknown tooling fixture');
}
