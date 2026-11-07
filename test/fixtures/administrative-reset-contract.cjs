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
ajv.addFormat('date-time', (value) => !Number.isNaN(Date.parse(value)));
const issue = contract.paths['/users/{id}/reset-credentials'].post,
  consume = contract.paths['/auth/temporary-password'].post;
const schema = (ref) => contract.components.schemas[ref.split('/').at(-1)];
const compile = (ref) => ajv.compile(schema(ref));
const issued = compile(
    issue.responses['200'].content['application/json'].schema.$ref,
  ),
  changed = compile(
    consume.responses['200'].content['application/json'].schema.$ref,
  ),
  body = compile(consume.requestBody.content['application/json'].schema.$ref);
exports.assertIssued = (value) =>
  assert.equal(issued(value), true, JSON.stringify(issued.errors));
exports.assertChanged = (value) =>
  assert.equal(changed(value), true, JSON.stringify(changed.errors));
exports.assertRequest = (value) =>
  assert.equal(body(value), true, JSON.stringify(body.errors));
exports.assertResetAuthentication = () => {
  assert.deepEqual(issue.security, [{ cookieAccess: [] }]);
  assert.deepEqual(consume.security, [{ temporaryResetCredential: [] }]);
  for (const op of [issue, consume])
    assert.ok(op.parameters.some((p) => p.name === 'Origin' && p.required));
  assert.ok(
    issue.parameters.some((p) => p.name === 'Idempotency-Key' && p.required),
  );
};
