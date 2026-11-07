const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const Ajv = require('ajv');
const contract = yaml.load(
  fs.readFileSync(
    path.resolve(__dirname, '../../contracts/openapi.yaml'),
    'utf8',
  ),
);
const ajv = new Ajv({ allErrors: true });
const operations = contract.paths['/settings/bot'];
const schema = (ref) => contract.components.schemas[ref.split('/').at(-1)];
const view = ajv.compile(
  schema(
    operations.get.responses['200'].content['application/json'].schema.$ref,
  ),
);
const patch = ajv.compile(
  schema(operations.patch.requestBody.content['application/json'].schema.$ref),
);
exports.assertDisplayResponse = (value) =>
  assert.equal(view(value), true, JSON.stringify(view.errors));
exports.isValidDisplayPatch = (value) => {
  const normalized =
    value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value }
      : value;
  if (normalized && typeof normalized.displayName === 'string')
    normalized.displayName = normalized.displayName.trim();
  return patch(normalized);
};
exports.assertOriginContract = () => {
  for (const operation of [
    operations.patch,
    contract.paths['/settings/modules/{kind}/enable'].post,
  ]) {
    assert.deepEqual(operation.security, [{ cookieAccess: [] }]);
    assert.ok(
      operation.parameters.some(
        (p) => p.name === 'Origin' && p.in === 'header' && p.required === true,
      ),
    );
  }
};
