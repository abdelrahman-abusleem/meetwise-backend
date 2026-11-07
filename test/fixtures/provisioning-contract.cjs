const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  yaml = require('js-yaml'),
  Ajv = require('ajv');
const contract = yaml.load(
  fs.readFileSync(
    path.resolve(__dirname, '../../contracts/openapi.yaml'),
    'utf8',
  ),
);
const ajv = new Ajv({ allErrors: true });
function resolve(value) {
  if (Array.isArray(value)) return value.map(resolve);
  if (value && typeof value === 'object') {
    if (value.$ref)
      return resolve(contract.components.schemas[value.$ref.split('/').at(-1)]);
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolve(v)]),
    );
  }
  return value;
}
const created = ajv.compile(
    resolve(
      contract.paths['/users'].post.responses['201'].content['application/json']
        .schema,
    ),
  ),
  issued = ajv.compile(
    resolve(
      contract.paths['/users/{id}/activation-credentials'].post.responses['200']
        .content['application/json'].schema,
    ),
  ),
  activated = ajv.compile(
    resolve(
      contract.paths['/auth/accept-invite'].post.responses['200'].content[
        'application/json'
      ].schema,
    ),
  );
exports.assertProvisioned = (value) =>
  assert.equal(created(value), true, JSON.stringify(created.errors));
exports.assertActivationIssued = (value) =>
  assert.equal(issued(value), true, JSON.stringify(issued.errors));
exports.assertActivated = (value) =>
  assert.equal(activated(value), true, JSON.stringify(activated.errors));
exports.assertProvisioningSecurity = () => {
  for (const p of [
    '/users',
    '/users/{id}/activation-credentials',
    '/users/{id}/activation-credentials/revoke',
  ]) {
    const op = contract.paths[p].post;
    assert.deepEqual(op.security, [{ cookieAccess: [] }]);
    assert.ok(op.parameters.some((p) => p.name === 'Origin' && p.required));
  }
  assert.deepEqual(contract.paths['/auth/accept-invite'].post.security, [
    { activationCredential: [] },
  ]);
  assert.ok(
    contract.paths['/auth/accept-invite'].post.parameters.some(
      (p) => p.name === 'Origin' && p.required,
    ),
  );
};
