const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  assertR04PublicAuthContract,
} = require('../fixtures/phase2-contract.cjs');
const baseline = yaml.load(
  fs.readFileSync(
    path.resolve(__dirname, '../../contracts/openapi.yaml'),
    'utf8',
  ),
);
function changed(mutate) {
  const doc = structuredClone(baseline);
  mutate(doc);
  return doc;
}
function denied(mutate) {
  assert.throws(() => assertR04PublicAuthContract(changed(mutate)), {
    name: 'AssertionError',
    code: 'ERR_ASSERTION',
    message: /R04/,
  });
}
test('R04 accepts the exact five approved public declarations and current protected definitions', () => {
  assertR04PublicAuthContract(baseline);
});
test('R04 rejects an added public-auth route', () =>
  denied((doc) => {
    doc.paths['/auth/register'] = {
      post: { operationId: 'post_auth_register', security: [] },
    };
  }));
test('R04 rejects a public operation with the wrong HTTP method', () =>
  denied((doc) => {
    doc.paths['/auth/login'].get = {
      operationId: 'get_auth_login',
      security: [],
    };
  }));
test('R04 rejects a different operation ID on an approved method/path', () =>
  denied((doc) => {
    doc.paths['/auth/login'].post.operationId = 'post_auth_register';
  }));
test('R04 rejects a global anonymous default', () =>
  denied((doc) => {
    doc.security = [];
  }));
for (const [route, method] of [
  ['/setup/complete', 'post'],
  ['/auth/me', 'get'],
  ['/auth/refresh', 'post'],
  ['/settings/bot', 'patch'],
  ['/auth/accept-invite', 'post'],
  ['/auth/temporary-password', 'post'],
])
  test('R04 rejects anonymous protection on ' + method + ' ' + route, () =>
    denied((doc) => {
      doc.paths[route][method].security = [];
    }),
  );
test('R04 rejects an anonymous OR alternative on a protected operation', () =>
  denied((doc) => {
    doc.paths['/auth/me'].get.security.push({});
  }));
test('R04 rejects an empty security requirement instead of the explicit approved declaration', () =>
  denied((doc) => {
    doc.paths['/auth/login'].post.security = [{}];
  }));
test('R04 rejects a missing public-auth Origin requirement', () =>
  denied((doc) => {
    doc.paths['/auth/reset-password'].post.parameters = [];
  }));
test('R04 rejects an optional bootstrap Origin requirement', () =>
  denied((doc) => {
    doc.paths['/setup/complete'].post.parameters.find(
      (p) => p.name === 'Origin',
    ).required = false;
  }));
test('R04 rejects renaming the required bootstrap header', () =>
  denied((doc) => {
    doc.components.securitySchemes.setupBootstrap.name = 'x-public-token';
  }));
test('R04 rejects access-cookie authentication substituted for refresh-cookie authentication', () =>
  denied((doc) => {
    doc.paths['/auth/refresh'].post.security = [{ cookieAccess: [] }];
  }));
test('R04 rejects a proposed bootstrap alias being declared public', () =>
  denied((doc) => {
    doc.paths['/auth/setup'].post.security = [];
  }));

test('R04 rejects anonymous declarations on any newly marked implemented route', () =>
  denied((doc) => {
    doc.paths['/administration/open'] = {
      get: {
        operationId: 'get_administration_open',
        security: [],
        'x-meetwise-status': 'IMPLEMENTED_LOCAL',
      },
    };
  }));

test('retained bootstrap design is explicitly protected and remains an unimplemented proposal', () => {
  const operation = baseline.paths['/auth/setup'].post;
  assert.equal(operation['x-meetwise-status'], 'PROPOSED');
  assert.equal(operation.deprecated, true);
  assert.deepEqual(operation.security, [{ setupBootstrap: [] }]);
  assert(
    operation.parameters.some(
      (parameter) =>
        parameter.name === 'Origin' &&
        parameter.in === 'header' &&
        parameter.required,
    ),
  );
});
