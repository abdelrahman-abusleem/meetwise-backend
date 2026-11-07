const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const Ajv = require('ajv');
const doc = yaml.load(
  fs.readFileSync(
    path.resolve(__dirname, '../../contracts/openapi.yaml'),
    'utf8',
  ),
);
const ajv = new Ajv({ allErrors: true });
function resolve(value, depth = 0) {
  assert(depth < 30, 'Schema reference depth exceeded');
  if (Array.isArray(value)) return value.map((v) => resolve(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value.$ref) {
      assert.match(value.$ref, /^#\/components\/schemas\/[A-Za-z0-9]+$/);
      const target = doc.components.schemas[value.$ref.split('/').at(-1)];
      assert(target, 'Missing schema ' + value.$ref);
      return resolve(target, depth + 1);
    }
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolve(v, depth + 1)]),
    );
  }
  return value;
}
exports.assertHttpContract = (route, method, status, body) => {
  const operation = doc.paths[route]?.[method];
  assert(operation, 'Missing actual operation ' + method + ' ' + route);
  const schema =
    operation.responses[String(status)]?.content?.['application/json']?.schema;
  assert(schema, 'Missing response ' + status + ' for ' + route);
  const check = ajv.compile(resolve(schema));
  assert.equal(
    check(body),
    true,
    route + ' ' + status + ' ' + JSON.stringify(check.errors),
  );
};
exports.assertRequestContract = (route, method, body, expected) => {
  const schema =
    doc.paths[route]?.[method]?.requestBody?.content?.['application/json']
      ?.schema;
  assert(schema, 'Missing request schema ' + route);
  const check = ajv.compile(resolve(schema));
  assert.equal(
    Boolean(check(body)),
    expected,
    route + ' request ' + JSON.stringify(check.errors),
  );
};

exports.assertImplementedDeclarations = () => {
  assertR04PublicAuthContract(doc);
  let count = 0;
  for (const [route, pathItem] of Object.entries(doc.paths))
    for (const [method, operation] of Object.entries(pathItem)) {
      if (
        operation['x-meetwise-status'] !== 'IMPLEMENTED_LOCAL' ||
        route.startsWith('/onboarding')
      )
        continue;
      count++;
      for (const [status, response] of Object.entries(operation.responses))
        if (Number(status) >= 400) {
          assert.equal(
            response.content['application/json'].schema.$ref,
            '#/components/schemas/RuntimeHttpError',
            method + ' ' + route,
          );
        }
      assert.deepEqual(operation.servers, [
        {
          url: '/',
          description:
            'Implemented controller paths are rooted here; no /api/v1 runtime prefix.',
        },
      ]);
    }
  assert.equal(count, 23, 'Implemented nonwizard operation inventory changed');
  assert.deepEqual(doc.paths['/setup/complete'].post.security, [
    { setupBootstrap: [] },
  ]);
  assert.equal(
    doc.components.securitySchemes.setupBootstrap.name,
    'x-meetwise-setup-token',
  );
  assert.deepEqual(doc.paths['/auth/refresh'].post.security, [
    { cookieRefresh: [] },
  ]);
  assert.equal(
    doc.components.securitySchemes.cookieRefresh.name,
    'meetwise_refresh_token',
  );
  for (const route of [
    '/auth/login',
    '/auth/refresh',
    '/auth/logout',
    '/auth/forgot-password',
    '/auth/reset-password',
    '/auth/password',
    '/setup/complete',
  ]) {
    const op = doc.paths[route][route === '/auth/password' ? 'patch' : 'post'];
    assert(op.parameters.some((p) => p.name === 'Origin' && p.required));
    assert(!op.parameters.some((p) => p.name === 'X-CSRF-Token'));
  }

  for (const [route, method] of [
    ['/auth/login', 'post'],
    ['/auth/forgot-password', 'post'],
    ['/auth/reset-password', 'post'],
    ['/health/live', 'get'],
    ['/health/ready', 'get'],
  ])
    assert.deepEqual(doc.paths[route][method].security, []);
  assert.equal(doc.paths['/auth/setup'].post['x-meetwise-status'], 'PROPOSED');
  assert(doc.components.schemas.Error.properties.error.type === 'object');
};

function assertR04PublicAuthContract(contract = doc) {
  const approved = new Map([
    ['post /auth/login', 'post_auth_login'],
    ['post /auth/forgot-password', 'post_auth_forgot_password'],
    ['post /auth/reset-password', 'post_auth_reset_password'],
    ['get /health/live', 'get_health_live'],
    ['get /health/ready', 'get_health_ready'],
  ]);
  const methods = new Set([
    'get',
    'post',
    'patch',
    'put',
    'delete',
    'options',
    'head',
    'trace',
  ]);
  const hasAnonymousAlternative = (security) =>
    Array.isArray(security) &&
    (security.length === 0 ||
      security.some(
        (requirement) =>
          requirement &&
          typeof requirement === 'object' &&
          Object.keys(requirement).length === 0,
      ));
  assert(
    !hasAnonymousAlternative(contract.security),
    'R04: no global anonymous security exception',
  );
  for (const [key, id] of approved) {
    const [method, route] = key.split(' '),
      operation = contract.paths[route]?.[method];
    assert(operation, 'R04: missing approved public operation ' + key);
    assert.equal(
      operation.operationId,
      id,
      'R04: approved operation ID changed ' + key,
    );
    assert.deepEqual(
      operation.security,
      [],
      'R04: public exception must be explicit ' + key,
    );
  }
  const credentialByRoute = {
    '/setup/complete': 'setupBootstrap',
    '/auth/refresh': 'cookieRefresh',
    '/auth/accept-invite': 'activationCredential',
    '/auth/temporary-password': 'temporaryResetCredential',
  };
  for (const [route, pathItem] of Object.entries(contract.paths)) {
    if (route.startsWith('/webhooks/')) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!methods.has(method)) continue;

      if (
        operation['x-meetwise-status'] !== 'IMPLEMENTED_LOCAL' &&
        !route.startsWith('/auth/') &&
        !route.startsWith('/health/') &&
        !route.startsWith('/setup/')
      )
        continue;
      const key = method + ' ' + route;
      if (hasAnonymousAlternative(operation.security)) {
        assert(
          approved.has(key),
          'R04: anonymous declaration outside approved five ' + key,
        );
        assert.deepEqual(
          operation.security,
          [],
          'R04: empty OR requirements are not the approved explicit declaration',
        );
      }
      if (operation['x-meetwise-status'] !== 'IMPLEMENTED_LOCAL') continue;
      if (!approved.has(key)) {
        const scheme = credentialByRoute[route] || 'cookieAccess';
        assert.deepEqual(
          operation.security,
          [{ [scheme]: [] }],
          'R04: protected credential changed ' + key,
        );
      }
      if (!['get', 'head', 'options'].includes(method))
        assert(
          operation.parameters?.some(
            (parameter) =>
              parameter.in === 'header' &&
              parameter.name === 'Origin' &&
              parameter.required === true,
          ),
          'R04: required Origin missing ' + key,
        );
    }
  }
  for (const [name, expected] of Object.entries({
    setupBootstrap: {
      type: 'apiKey',
      in: 'header',
      name: 'x-meetwise-setup-token',
    },
    cookieAccess: {
      type: 'apiKey',
      in: 'cookie',
      name: 'meetwise_access_token',
    },
    cookieRefresh: {
      type: 'apiKey',
      in: 'cookie',
      name: 'meetwise_refresh_token',
    },
    activationCredential: { type: 'http', scheme: 'bearer' },
    temporaryResetCredential: { type: 'http', scheme: 'bearer' },
  })) {
    const actual = contract.components.securitySchemes[name];
    assert(actual, 'R04: missing credential scheme ' + name);
    for (const [property, value] of Object.entries(expected))
      assert.equal(
        actual[property],
        value,
        'R04: credential scheme mismatch ' + name + '.' + property,
      );
  }
}
exports.assertR04PublicAuthContract = assertR04PublicAuthContract;
