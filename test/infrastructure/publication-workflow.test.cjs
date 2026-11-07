const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const branch = 'codex/source-publication-20261104';
const guard = `github.ref != 'refs/heads/${branch}' && github.head_ref != '${branch}'`;
const directory = path.resolve(__dirname, '../../.github/workflows');
const workflow = yaml.load(
  fs.readFileSync(path.join(directory, 'quality.yml'), 'utf8'),
);

function verify(value) {
  assert.deepEqual(Object.keys(value.on).sort(), ['pull_request', 'push']);
  assert.deepEqual(value.on.push['branches-ignore'], [branch]);
  for (const job of Object.values(value.jobs)) assert.equal(job.if, guard);
  assert.deepEqual(value.permissions, { contents: 'read' });
}

test('source publication has an exact push exclusion and a job guard before infrastructure allocation', () =>
  verify(workflow));
test('all published workflow files are covered by this policy', () => {
  assert.deepEqual(
    fs
      .readdirSync(directory)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort(),
    ['quality.yml'],
  );
});
test('missing branch exclusion is refused', () => {
  const value = structuredClone(workflow);
  delete value.on.push['branches-ignore'];
  assert.throws(() => verify(value));
});
test('an unguarded matrix job is refused', () => {
  const value = structuredClone(workflow);
  delete value.jobs.quality.if;
  assert.throws(() => verify(value));
});
test('additional dispatch, create, schedule or workflow-run automation is refused', () => {
  for (const event of [
    'workflow_dispatch',
    'create',
    'schedule',
    'workflow_run',
    'pull_request_target',
  ]) {
    const value = structuredClone(workflow);
    value.on[event] = {};
    assert.throws(() => verify(value));
  }
});
test('the configured condition excludes the publication ref and PR head without excluding main', () => {
  verify(workflow);
  const allowed = (ref, head) =>
    ref !== `refs/heads/${branch}` && head !== branch;
  assert.equal(allowed(`refs/heads/${branch}`, ''), false);
  assert.equal(allowed('refs/pull/1/merge', branch), false);
  assert.equal(allowed('refs/heads/main', ''), true);
});
