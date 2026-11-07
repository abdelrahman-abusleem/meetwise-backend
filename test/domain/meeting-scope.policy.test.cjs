const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MeetingScopePolicy,
} = require('../../libs/meetings/src/domain/meeting-scope.policy.ts');

const policy = new MeetingScopePolicy();
const tech = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'TECH',
});
const sales = Object.freeze({
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'SALES',
});

test('GENERAL defaults to COMPANY with no department or guest prerequisite', () => {
  assert.deepEqual(policy.normalize({ kind: 'GENERAL' }), {
    ok: true,
    scope: { kind: 'GENERAL', departmentId: null, visibility: 'COMPANY' },
  });
});

test('GENERAL preserves an explicit PRIVATE selection as scope, without granting access', () => {
  assert.deepEqual(
    policy.normalize({ kind: 'GENERAL', visibility: 'PRIVATE' }),
    {
      ok: true,
      scope: { kind: 'GENERAL', departmentId: null, visibility: 'PRIVATE' },
    },
  );
});

for (const departmentId of [tech.id, null, '']) {
  test(`GENERAL rejects a supplied department (${String(departmentId)})`, () => {
    assert.deepEqual(policy.normalize({ kind: 'GENERAL', departmentId }), {
      ok: false,
      reason: 'DEPARTMENT_FORBIDDEN',
    });
  });
}

test('GENERAL rejects a resolved department even when the request omitted it', () => {
  assert.deepEqual(policy.normalize({ kind: 'GENERAL' }, tech), {
    ok: false,
    reason: 'DEPARTMENT_FORBIDDEN',
  });
});

for (const department of [tech, sales]) {
  test(`${department.kind} defaults to DEPARTMENT only with the exact resolved identity`, () => {
    assert.deepEqual(
      policy.normalize(
        { kind: department.kind, departmentId: department.id },
        department,
      ),
      {
        ok: true,
        scope: {
          kind: department.kind,
          departmentId: department.id,
          visibility: 'DEPARTMENT',
        },
      },
    );
  });
  test(`${department.kind} preserves valid PRIVATE scope`, () => {
    assert.equal(
      policy.normalize(
        {
          kind: department.kind,
          departmentId: department.id,
          visibility: 'PRIVATE',
        },
        department,
      ).scope.visibility,
      'PRIVATE',
    );
  });
  test(`${department.kind} rejects COMPANY visibility`, () => {
    assert.deepEqual(
      policy.normalize(
        {
          kind: department.kind,
          departmentId: department.id,
          visibility: 'COMPANY',
        },
        department,
      ),
      { ok: false, reason: 'INVALID_VISIBILITY' },
    );
  });
  test(`${department.kind} rejects a missing department`, () => {
    assert.deepEqual(policy.normalize({ kind: department.kind }, department), {
      ok: false,
      reason: 'DEPARTMENT_REQUIRED',
    });
  });
  test(`${department.kind} rejects a department not resolved by the caller`, () => {
    assert.deepEqual(
      policy.normalize({ kind: department.kind, departmentId: department.id }),
      { ok: false, reason: 'DEPARTMENT_MISMATCH' },
    );
  });
}

test('department kind must match the requested meeting kind', () => {
  assert.deepEqual(
    policy.normalize({ kind: 'TECH', departmentId: sales.id }, sales),
    { ok: false, reason: 'DEPARTMENT_MISMATCH' },
  );
});

test('request department cannot replace the resolved department identity', () => {
  assert.deepEqual(
    policy.normalize({ kind: 'SALES', departmentId: tech.id }, sales),
    { ok: false, reason: 'DEPARTMENT_MISMATCH' },
  );
});

for (const visibility of [null, '', 'department', true, 1]) {
  test(`does not coerce invalid visibility (${String(visibility)})`, () => {
    assert.deepEqual(policy.normalize({ kind: 'GENERAL', visibility }), {
      ok: false,
      reason: 'INVALID_VISIBILITY',
    });
  });
}

for (const request of [null, [], 'GENERAL', 1]) {
  test(`rejects a non-record request (${JSON.stringify(request)})`, () => {
    assert.deepEqual(policy.normalize(request), {
      ok: false,
      reason: 'INVALID_REQUEST',
    });
  });
}

for (const kind of ['HR', 'tech', '', null]) {
  test(`rejects an unknown meeting kind (${String(kind)})`, () => {
    assert.deepEqual(policy.normalize({ kind }), {
      ok: false,
      reason: 'INVALID_MEETING_KIND',
    });
  });
}

test('GENERAL cannot use DEPARTMENT visibility', () => {
  assert.deepEqual(
    policy.normalize({ kind: 'GENERAL', visibility: 'DEPARTMENT' }),
    { ok: false, reason: 'INVALID_VISIBILITY' },
  );
});

test('does not mutate input and freezes primitive-only result values', () => {
  const request = Object.freeze({ kind: 'TECH', departmentId: tech.id });
  const result = policy.normalize(request, tech);
  assert.deepEqual(request, { kind: 'TECH', departmentId: tech.id });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.scope));
  assert.equal(Reflect.set(result.scope, 'visibility', 'COMPANY'), false);
});

test('reused instance keeps independent calls separate', async () => {
  const results = await Promise.all(
    [tech, sales].map(async (department) =>
      policy.normalize(
        { kind: department.kind, departmentId: department.id },
        department,
      ),
    ),
  );
  assert.deepEqual(
    results.map((value) => value.scope.departmentId),
    [tech.id, sales.id],
  );
  assert.notEqual(results[0].scope, results[1].scope);
});
