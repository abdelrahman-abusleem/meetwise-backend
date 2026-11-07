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
const result = ajv.compile(
    resolve(doc.components.schemas.WizardActivationResult),
  ),
  state = ajv.compile(resolve(doc.components.schemas.OnboardingState)),
  error = ajv.compile(resolve(doc.components.schemas.WizardRuntimeError));
exports.assertActivation = (value, status) => {
  const check = status >= 400 ? error : result;
  assert.equal(check(value), true, JSON.stringify(check.errors));
  if (status >= 400) assert.equal(value.statusCode, status);
};
exports.assertOnboarding = (value) =>
  assert.equal(state(value), true, JSON.stringify(state.errors));
exports.assertActivationSecurity = () => {
  const op = doc.paths['/onboarding/activate'].post;
  assert.deepEqual(op.security, [{ cookieAccess: [] }]);
  for (const n of ['Origin', 'If-Match', 'Idempotency-Key'])
    assert.ok(op.parameters.some((p) => p.name === n && p.required));
};
