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
function resolve(v) {
  if (Array.isArray(v)) return v.map(resolve);
  if (v && typeof v === 'object') {
    if (v.$ref)
      return resolve(doc.components.schemas[v.$ref.split('/').at(-1)]);
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, resolve(x)]),
    );
  }
  return v;
}
const member = ajv.compile(resolve(doc.components.schemas.MemberRecord)),
  page = ajv.compile(resolve(doc.components.schemas.MemberPage));
exports.assertMember = (value) =>
  assert.equal(member(value), true, JSON.stringify(member.errors));
exports.assertMemberPage = (value) =>
  assert.equal(page(value), true, JSON.stringify(page.errors));
exports.assertMembershipSecurity = () => {
  for (const [p, m] of [
    ['/departments/{departmentId}/members', 'post'],
    ['/departments/{departmentId}/members/{userId}', 'patch'],
    ['/departments/{departmentId}/members/{userId}/revoke', 'post'],
  ]) {
    const op = doc.paths[p][m];
    assert.deepEqual(op.security, [{ cookieAccess: [] }]);
    for (const name of ['Origin', 'If-Match', 'Idempotency-Key'])
      assert.ok(op.parameters.some((p) => p.name === name && p.required));
  }
};
