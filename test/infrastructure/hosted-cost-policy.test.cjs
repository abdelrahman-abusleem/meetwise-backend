const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const workflow = yaml.load(
  fs.readFileSync(
    path.resolve(__dirname, '../../.github/workflows/quality.yml'),
    'utf8',
  ),
);
function verify(value) {
  assert.deepEqual(value.permissions, { contents: 'read' });
  assert(!Object.keys(value.on).includes('pull_request_target'));
  for (const job of Object.values(value.jobs)) {
    assert.equal(job['runs-on'], 'ubuntu-24.04');
    assert(!job.snapshot);
    for (const step of job.steps) {
      assert(
        !/actions\/(?:cache|upload-artifact)(?:\/|@)/.test(step.uses || ''),
      );
      if ((step.uses || '').startsWith('actions/setup-node@')) {
        assert(!step.with.cache);
        assert.equal(step.with['package-manager-cache'], false);
      }
    }
  }
  assert(!/\$\{\{\s*secrets\./.test(JSON.stringify(value)));
}
test('hosted candidate uses standard public runner without cache/artifact storage or secrets', () =>
  verify(workflow));
test('rejects paid larger runner', () => {
  const v = structuredClone(workflow);
  v.jobs.quality['runs-on'] = 'paid-linux-16-core';
  assert.throws(() => verify(v));
});
test('rejects implicit package-manager cache', () => {
  const v = structuredClone(workflow);
  delete v.jobs.quality.steps.find((s) =>
    (s.uses || '').startsWith('actions/setup-node@'),
  ).with['package-manager-cache'];
  assert.throws(() => verify(v));
});
test('rejects explicit cache writes', () => {
  const v = structuredClone(workflow);
  v.jobs.quality.steps.push({ uses: 'actions/cache@synthetic' });
  assert.throws(() => verify(v));
});
test('rejects artifact storage', () => {
  const v = structuredClone(workflow);
  v.jobs.quality.steps.push({ uses: 'actions/upload-artifact@synthetic' });
  assert.throws(() => verify(v));
});
test('rejects privileged token permissions', () => {
  const v = structuredClone(workflow);
  v.permissions = { contents: 'write' };
  assert.throws(() => verify(v));
});
test('rejects provider secret injection', () => {
  const v = structuredClone(workflow);
  v.jobs.quality.env.PROVIDER = '${{ secrets.SYNTHETIC_PROVIDER }}';
  assert.throws(() => verify(v));
});
