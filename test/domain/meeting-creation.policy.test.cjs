const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MeetingCreationPolicy,
} = require('../../libs/meetings/src/domain/meeting-creation.policy.ts');
const {
  MeetingScopePolicy,
} = require('../../libs/meetings/src/domain/meeting-scope.policy.ts');
const policy = new MeetingCreationPolicy();
const scopePolicy = new MeetingScopePolicy();
const dept = { id: 'department-tech', kind: 'TECH' };
const scope = scopePolicy.normalize(
  { kind: 'TECH', departmentId: dept.id },
  dept,
).scope;
const general = scopePolicy.normalize({ kind: 'GENERAL' }).scope;
const user = (id = 'creator', role = 'MEMBER') => ({
  id,
  role,
  isActive: true,
});
const member = (overrides = {}) => ({
  userId: 'creator',
  departmentId: dept.id,
  role: 'MEMBER',
  canCreateMeetings: false,
  canManageMeetings: false,
  ...overrides,
});
const allowed = (creator = 'creator', manager = creator) => ({
  ok: true,
  createdById: creator,
  meetingAdminId: manager,
});
const denied = (reason) => ({ ok: false, reason });

for (const role of ['OWNER', 'MANAGER']) {
  test(`${role} creates GENERAL with no guest or membership`, () => {
    assert.deepEqual(policy.decide(general, user('creator', role)), allowed());
  });
  test(`${role} creates department meeting without membership`, () => {
    assert.deepEqual(policy.decide(scope, user('creator', role)), allowed());
  });
}
for (const role of [
  'MEMBER',
  'ADMIN',
  'MEETING_ADMIN',
  'REVIEWER',
  'APPROVER',
  'unknown',
]) {
  test(`${role} cannot create GENERAL through title or department grants`, () => {
    assert.deepEqual(
      policy.decide(
        general,
        user('creator', role),
        member({
          role: 'ADMIN',
          canCreateMeetings: true,
          canManageMeetings: true,
        }),
      ),
      denied('CREATION_FORBIDDEN'),
    );
  });
}
test('inactive OWNER cannot create', () => {
  assert.deepEqual(
    policy.decide(general, { ...user('creator', 'OWNER'), isActive: false }),
    denied('CREATION_FORBIDDEN'),
  );
});
test('department ADMIN becomes meeting admin without member permission booleans', () => {
  assert.deepEqual(
    policy.decide(scope, user(), member({ role: 'ADMIN' })),
    allowed(),
  );
});
test('member with create and manage becomes meeting admin', () => {
  assert.deepEqual(
    policy.decide(
      scope,
      user(),
      member({ canCreateMeetings: true, canManageMeetings: true }),
    ),
    allowed(),
  );
});
for (const permissions of [
  {},
  { canManageMeetings: true },
  { canApproveMeetings: true },
  { canCreateMeetings: 'true', canManageMeetings: true },
]) {
  test(`member without exact create grant is denied (${JSON.stringify(permissions)})`, () => {
    assert.deepEqual(
      policy.decide(scope, user(), member(permissions)),
      denied('CREATION_FORBIDDEN'),
    );
  });
}
for (const mismatch of [
  { userId: 'other' },
  { departmentId: 'department-sales' },
  { role: 'OWNER' },
]) {
  test(`membership identity/department/role mismatch cannot create (${JSON.stringify(mismatch)})`, () => {
    assert.deepEqual(
      policy.decide(scope, user(), member({ role: 'ADMIN', ...mismatch })),
      denied('CREATION_FORBIDDEN'),
    );
  });
}
test('create-only member cannot create orphan meeting', () => {
  assert.deepEqual(
    policy.decide(scope, user(), member({ canCreateMeetings: true })),
    denied('ELIGIBLE_MANAGER_REQUIRED'),
  );
});
for (const managerRole of ['OWNER', 'MANAGER']) {
  test(`create-only member may select active system ${managerRole}`, () => {
    assert.deepEqual(
      policy.decide(scope, user(), member({ canCreateMeetings: true }), {
        user: user('manager', managerRole),
        membership: null,
      }),
      allowed('creator', 'manager'),
    );
  });
}
for (const managerMembership of [
  member({ userId: 'manager', role: 'ADMIN' }),
  member({ userId: 'manager', canManageMeetings: true }),
]) {
  test(`create-only may select scoped eligible ${managerMembership.role}`, () => {
    assert.deepEqual(
      policy.decide(scope, user(), member({ canCreateMeetings: true }), {
        user: user('manager'),
        membership: managerMembership,
      }),
      allowed('creator', 'manager'),
    );
  });
}
for (const candidate of [
  { user: { ...user('manager', 'OWNER'), isActive: false }, membership: null },
  {
    user: user('manager'),
    membership: member({
      userId: 'manager',
      departmentId: 'department-sales',
      role: 'ADMIN',
    }),
  },
  {
    user: user('manager'),
    membership: member({ userId: 'someone-else', role: 'ADMIN' }),
  },
  {
    user: user('manager'),
    membership: member({ userId: 'manager', canCreateMeetings: true }),
  },
  {
    user: user('manager', 'ADMIN'),
    membership: member({ userId: 'manager', role: 'ADMIN' }),
  },
  { user: user(), membership: member({ canCreateMeetings: true }) },
]) {
  test(`rejects ineligible selected manager case ${JSON.stringify(candidate)}`, () => {
    assert.deepEqual(
      policy.decide(
        scope,
        user(),
        member({ canCreateMeetings: true }),
        candidate,
      ),
      denied('ELIGIBLE_MANAGER_REQUIRED'),
    );
  });
}
test('automatic creator management cannot reassign another user during creation', () => {
  assert.deepEqual(
    policy.decide(scope, user(), member({ role: 'ADMIN' }), {
      user: user('other', 'OWNER'),
      membership: null,
    }),
    denied('MANAGER_SELECTION_NOT_PERMITTED'),
  );
});
test('explicit same creator selection does not change automatic assignment', () => {
  assert.deepEqual(
    policy.decide(scope, user(), member({ role: 'ADMIN' }), {
      user: user(),
      membership: member({ role: 'ADMIN' }),
    }),
    allowed(),
  );
});
test('does not cache earlier create/manage grants after facts are revoked', () => {
  const grants = member({ canCreateMeetings: true, canManageMeetings: true });
  assert.deepEqual(policy.decide(scope, user(), grants), allowed());
  grants.canCreateMeetings = false;
  assert.deepEqual(
    policy.decide(scope, user(), grants),
    denied('CREATION_FORBIDDEN'),
  );
});
test('revoked selected manager fails the next evaluation', () => {
  const selected = {
    user: user('manager'),
    membership: member({ userId: 'manager', canManageMeetings: true }),
  };
  assert.deepEqual(
    policy.decide(scope, user(), member({ canCreateMeetings: true }), selected),
    allowed('creator', 'manager'),
  );
  selected.membership.canManageMeetings = false;
  assert.deepEqual(
    policy.decide(scope, user(), member({ canCreateMeetings: true }), selected),
    denied('ELIGIBLE_MANAGER_REQUIRED'),
  );
});
test('frozen facts remain unchanged and result grants only immutable IDs', () => {
  const actor = Object.freeze(user());
  const grants = Object.freeze(member({ role: 'ADMIN' }));
  const result = policy.decide(scope, actor, grants);
  assert.deepEqual(result, allowed());
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(Object.keys(result).sort(), [
    'createdById',
    'meetingAdminId',
    'ok',
  ]);
  assert.equal(Reflect.set(result, 'meetingAdminId', 'other'), false);
  assert.equal(grants.role, 'ADMIN');
});

test('SALES creation uses SALES grants independently of TECH', () => {
  const salesDepartment = { id: 'department-sales', kind: 'SALES' };
  const salesScope = scopePolicy.normalize(
    { kind: 'SALES', departmentId: salesDepartment.id },
    salesDepartment,
  ).scope;
  assert.deepEqual(
    policy.decide(salesScope, user(), member({ role: 'ADMIN' })),
    denied('CREATION_FORBIDDEN'),
  );
  assert.deepEqual(
    policy.decide(
      salesScope,
      user(),
      member({ role: 'ADMIN', departmentId: salesDepartment.id }),
    ),
    allowed(),
  );
});
test('inactive member cannot create despite scoped grants', () => {
  assert.deepEqual(
    policy.decide(
      scope,
      { ...user(), isActive: false },
      member({ canCreateMeetings: true, canManageMeetings: true }),
    ),
    denied('CREATION_FORBIDDEN'),
  );
});
test('system management revocation removes GENERAL creation next evaluation', () => {
  const actor = user('creator', 'MANAGER');
  assert.deepEqual(policy.decide(general, actor), allowed());
  actor.role = 'MEMBER';
  assert.deepEqual(policy.decide(general, actor), denied('CREATION_FORBIDDEN'));
});
test('conflicting selected facts cannot elevate create-only creator into own manager', () => {
  assert.deepEqual(
    policy.decide(scope, user(), member({ canCreateMeetings: true }), {
      user: user('creator', 'OWNER'),
      membership: null,
    }),
    denied('ELIGIBLE_MANAGER_REQUIRED'),
  );
});

test('create-only member cannot select PRIVATE through another eligible manager', () => {
  const privateScope = scopePolicy.normalize(
    { kind: 'TECH', departmentId: dept.id, visibility: 'PRIVATE' },
    dept,
  ).scope;
  assert.deepEqual(
    policy.decide(privateScope, user(), member({ canCreateMeetings: true }), {
      user: user('manager', 'OWNER'),
      membership: null,
    }),
    denied('PRIVATE_VISIBILITY_FORBIDDEN'),
  );
});

for (const facts of [
  { user: user('creator', 'OWNER'), membership: null },
  { user: user('creator', 'MANAGER'), membership: null },
  { user: user(), membership: member({ role: 'ADMIN' }) },
  {
    user: user(),
    membership: member({ canCreateMeetings: true, canManageMeetings: true }),
  },
]) {
  test(`current managing creator may choose PRIVATE (${JSON.stringify(facts)})`, () => {
    const privateScope = scopePolicy.normalize(
      { kind: 'TECH', departmentId: dept.id, visibility: 'PRIVATE' },
      dept,
    ).scope;
    assert.deepEqual(
      policy.decide(privateScope, facts.user, facts.membership),
      allowed(),
    );
  });
}
