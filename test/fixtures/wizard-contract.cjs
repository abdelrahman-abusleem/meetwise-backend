const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  yaml = require('js-yaml'),
  Ajv = require('ajv');
const doc = yaml.load(
    fs.readFileSync(
      path.resolve(__dirname, '../../contracts/openapi.yaml'),
      'utf8',
    ),
  ),
  ajv = new Ajv({ allErrors: true });
function resolve(value, depth = 0) {
  assert(depth < 20);
  if (Array.isArray(value)) return value.map((v) => resolve(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value.$ref) {
      assert.match(value.$ref, /^#\/components\/schemas\/[A-Za-z0-9]+$/);
      return resolve(
        doc.components.schemas[value.$ref.split('/').at(-1)],
        depth + 1,
      );
    }
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolve(v, depth + 1)]),
    );
  }
  return value;
}
const check = ajv.compile(resolve(doc.components.schemas.WizardDraftView));
exports.assertWizardDraft = (v) =>
  assert.equal(check(v), true, JSON.stringify(check.errors));
exports.assertWizardSecurity = () => {
  for (const [p, m] of [
    ['/onboarding/draft', 'post'],
    ['/onboarding/draft', 'patch'],
    ['/onboarding/draft/{draftId}', 'get'],
  ]) {
    const op = doc.paths[p][m];
    assert.deepEqual(op.security, [{ cookieAccess: [] }]);
    if (m !== 'get')
      for (const name of [
        'Origin',
        'Idempotency-Key',
        ...(m === 'patch' ? ['If-Match'] : []),
      ])
        assert.ok(op.parameters.some((p) => p.name === name && p.required));
  }
};

const error = ajv.compile(resolve(doc.components.schemas.WizardRuntimeError));
exports.assertWizardError = (value, status) => {
  assert.equal(error(value), true, JSON.stringify(error.errors));
  assert.equal(value.statusCode, status);
  for (const p of ['/onboarding/draft', '/onboarding/draft/{draftId}'])
    for (const op of Object.values(doc.paths[p]))
      for (const [code, response] of Object.entries(op.responses))
        if (Number(code) >= 400)
          assert.equal(
            response.content['application/json'].schema.$ref,
            '#/components/schemas/WizardRuntimeError',
          );
};
