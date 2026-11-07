const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MeetingCreateService,
} = require('../../apps/api/src/modules/meetings/meeting-create.service.ts');
const {
  MeetingCreateStore,
} = require('../../apps/api/src/modules/meetings/meeting-create.store.ts');
const creatorId = '11111111-1111-4111-8111-111111111111';
const managerId = '22222222-2222-4222-8222-222222222222';
const departmentId = '33333333-3333-4333-8333-333333333333';
const actor = {
  id: creatorId,
  familyId: '44444444-4444-4444-8444-444444444444',
  role: 'OWNER',
  tokenVersion: 0,
};
const general = { kind: 'GENERAL', title: 'Planning' };
const tech = { kind: 'TECH', departmentId, title: 'Planning' };

function fixture() {
  const state = {
    rows: [],
    receipts: [],
    creator: { id: creatorId, role: 'OWNER', isActive: true },
    manager: { id: managerId, role: 'MEMBER', isActive: true },
    department: { id: departmentId, kind: 'TECH', status: 'ACTIVE' },
    grants: [],
    initialized: true,
    expired: false,
    failStep: 0,
    expireAtStep: 0,
    targetLookups: 0,
    trace: [],
  };
  const db = {
    async $transaction(operation) {
      const working = structuredClone({
        rows: state.rows,
        receipts: state.receipts,
      });
      let step = 0;
      const tx = {
        user: {
          findUniqueOrThrow: async () => {
            state.trace.push('creator');
            return state.creator;
          },
          findUnique: async ({ where }) => {
            state.targetLookups++;
            return where.id === creatorId
              ? state.creator
              : where.id === managerId
                ? state.manager
                : null;
          },
        },
        systemSetting: {
          findFirst: async () =>
            state.initialized ? { id: 'installation' } : null,
        },
        departmentMembership: {
          findMany: async ({ where }) =>
            state.grants.filter(
              (grant) =>
                grant.departmentId === where.departmentId &&
                where.userId.in.includes(grant.userId) &&
                !grant.revokedAt,
            ),
        },
        authSession: {
          findUnique: async () => ({
            expiresAt: new Date(Date.now() + (state.expired ? -1000 : 60000)),
          }),
        },
        async $queryRaw(strings, ...values) {
          const sql = strings.join('?');
          if (sql.includes('FROM departments'))
            return state.department?.id === values[0] ? [state.department] : [];
          if (sql.includes('FROM meeting_create_requests'))
            return working.receipts.filter(
              (receipt) =>
                receipt.actorId === values[0] && receipt.keyHash === values[1],
            );
          throw Error('Unexpected unit query');
        },
        async $executeRaw(strings, ...values) {
          step++;
          if (step === state.failStep)
            throw new Error('Synthetic persistence failure');
          if (step === state.expireAtStep) state.expired = true;
          const sql = strings.join('?');
          const table = /INSERT INTO ([a-z_]+)/.exec(sql)?.[1];
          assert.ok(table, 'All persistence statements must be inserts');
          working.rows.push({ table, values });
          if (table === 'meeting_create_requests')
            working.receipts.push({
              actorId: values[0],
              keyHash: values[1],
              payloadHash: values[2],
              response: JSON.parse(values[4]),
            });
          return 1;
        },
      };
      const result = await operation(tx);
      state.rows = working.rows;
      state.receipts = working.receipts;
      return result;
    },
  };
  const authority = {
    async assertActiveSystemActor(_tx, identity, roles, selectedManagerId) {
      state.trace.push('authority');
      assert.equal(identity.id, creatorId);
      assert.deepEqual(roles, ['OWNER', 'MANAGER', 'MEMBER']);
      state.lockedSelectedManager = selectedManagerId;
      if (state.expired) {
        const { UnauthorizedException } = require('@nestjs/common');
        throw new UnauthorizedException();
      }
    },
  };
  return {
    state,
    service: new MeetingCreateService(db, authority, new MeetingCreateStore()),
  };
}
const grant = (id, manage = false) => ({
  userId: id,
  departmentId,
  role: 'MEMBER',
  canCreateMeetings: true,
  canManageMeetings: manage,
  revokedAt: null,
});

test('GENERAL creates DRAFT, manager access, audit, ID-only outbox and receipt through one transaction', async () => {
  const { service, state } = fixture();
  const result = await service.create(actor, general, 'key');
  assert.equal(result.lifecycle, 'DRAFT');
  assert.equal(result.visibility, 'COMPANY');
  assert.equal(result.createdById, creatorId);
  assert.equal(result.meetingAdminId, creatorId);
  assert.deepEqual(state.trace.slice(0, 2), ['authority', 'creator']);
  assert.deepEqual(
    state.rows.map((row) => row.table),
    [
      'meetings',
      'meeting_access',
      'meeting_creation_audit',
      'outbox_events',
      'meeting_create_requests',
    ],
  );
  assert.deepEqual(JSON.parse(state.rows[3].values[2]), {
    meetingId: result.id,
  });
  assert.equal(state.rows[1].values[1], creatorId);
});
test('same actor/key/payload returns same committed response with no second writes', async () => {
  const { service, state } = fixture();
  const first = await service.create(actor, general, 'key');
  assert.deepEqual(
    await service.create(actor, { title: 'Planning', kind: 'GENERAL' }, 'key'),
    first,
  );
  assert.equal(state.rows.length, 5);
});
test('same actor/key/different payload conflicts and preserves earlier meeting', async () => {
  const { service, state } = fixture();
  await service.create(actor, general, 'key');
  await assert.rejects(
    service.create(actor, { ...general, title: 'Changed' }, 'key'),
    (error) => error.getStatus() === 409,
  );
  assert.equal(state.rows.length, 5);
});
for (let step = 1; step <= 5; step++)
  test(`failure at persistence step ${step} aborts unit transaction without partial rows`, async () => {
    const { service, state } = fixture();
    state.failStep = step;
    await assert.rejects(
      service.create(actor, general, 'key'),
      /Synthetic persistence failure/,
    );
    assert.equal(state.rows.length, 0);
    assert.equal(state.receipts.length, 0);
  });
test('session expiry during persistence aborts before successful return', async () => {
  const { service, state } = fixture();
  state.expireAtStep = 3;
  await assert.rejects(
    service.create(actor, general, 'key'),
    (error) => error.getStatus() === 401,
  );
  assert.equal(state.rows.length, 0);
});
test('expired authentication prevents replay and all writes', async () => {
  const { service, state } = fixture();
  await service.create(actor, general, 'key');
  state.expired = true;
  await assert.rejects(
    service.create(actor, general, 'key'),
    (error) => error.getStatus() === 401,
  );
  assert.equal(state.rows.length, 5);
});
test('current database role overrides stale OWNER claim before selected-user lookup', async () => {
  const { service, state } = fixture();
  state.creator.role = 'MEMBER';
  await assert.rejects(
    service.create(actor, { ...general, meetingAdminId: managerId }, 'key'),
    (error) => error.getStatus() === 403,
  );
  assert.equal(state.rows.length, 0);
  assert.equal(state.targetLookups, 0);
});
test('department member cannot enumerate inaccessible department', async () => {
  const { service, state } = fixture();
  state.creator.role = 'MEMBER';
  await assert.rejects(
    service.create(actor, tech, 'key'),
    (error) => error.getStatus() === 404,
  );
  assert.equal(state.rows.length, 0);
});
test('create-only member assigns eligible current manager from same department', async () => {
  const { service, state } = fixture();
  state.creator.role = 'MEMBER';
  state.grants = [grant(creatorId), grant(managerId, true)];
  const result = await service.create(
    actor,
    { ...tech, meetingAdminId: managerId },
    'key',
  );
  assert.equal(result.meetingAdminId, managerId);
  assert.equal(result.createdById, creatorId);
  assert.equal(result.visibility, 'DEPARTMENT');
  assert.equal(state.lockedSelectedManager, managerId);
});
for (const change of ['missing', 'inactive', 'revoked', 'cross-department'])
  test(`invalid selected manager ${change} denies all writes`, async () => {
    const { service, state } = fixture();
    state.creator.role = 'MEMBER';
    state.grants = [grant(creatorId), grant(managerId, true)];
    if (change === 'missing') state.manager = null;
    if (change === 'inactive') state.manager.isActive = false;
    if (change === 'revoked') state.grants[1].revokedAt = new Date();
    if (change === 'cross-department') state.grants[1].departmentId = 'other';
    await assert.rejects(
      service.create(actor, { ...tech, meetingAdminId: managerId }, 'key'),
      (error) => error.getStatus() === 422,
    );
    assert.equal(state.rows.length, 0);
  });
test('create-only member PRIVATE denial precedes lookup even with eligible selected manager', async () => {
  const { service, state } = fixture();
  state.creator.role = 'MEMBER';
  state.grants = [grant(creatorId), grant(managerId, true)];
  await assert.rejects(
    service.create(
      actor,
      { ...tech, visibility: 'PRIVATE', meetingAdminId: managerId },
      'key',
    ),
    (error) => error.getStatus() === 403,
  );
  assert.equal(state.targetLookups, 0);
  assert.equal(state.rows.length, 0);
});
test('permission revoked after earlier success prevents replay disclosure', async () => {
  const { service, state } = fixture();
  state.creator.role = 'MEMBER';
  state.grants = [grant(creatorId, true)];
  await service.create(actor, tech, 'key');
  state.grants[0].revokedAt = new Date();
  await assert.rejects(
    service.create(actor, tech, 'key'),
    (error) => error.getStatus() === 404,
  );
  assert.equal(state.rows.length, 5);
});
for (const status of ['DISABLED', 'CONFIGURING', 'SUSPENDED'])
  test(`department ${status} prevents creation even for OWNER`, async () => {
    const { service, state } = fixture();
    state.department.status = status;
    await assert.rejects(
      service.create(actor, tech, 'key'),
      (error) => error.getStatus() === 409,
    );
    assert.equal(state.rows.length, 0);
  });
