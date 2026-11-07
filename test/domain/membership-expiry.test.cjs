require('../register-meeting-tests.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DepartmentMembershipsService,
} = require('../../apps/api/src/modules/departments/department-memberships.service.ts');

function fixture({ advanceAt, revoked = false, deadline = 1005 } = {}) {
  let now = 1000;
  const clock = () => now;
  const actor = { id: 'synthetic-owner', familyId: 'synthetic-family' };
  const grant = {
    role: 'MEMBER',
    canCreateMeetings: false,
    canManageMeetings: false,
    canApproveMeetings: false,
  };
  const row = {
    departmentId: 'synthetic-department',
    userId: 'synthetic-target',
    ...grant,
    version: 0,
    revokedAt: revoked ? new Date(900) : null,
  };
  const committed = [];
  let draft;
  const wait = (name) => {
    if (advanceAt === name) now = 1010;
  };
  const tx = {
    $queryRaw: async () => [{ id: row.departmentId, status: 'ACTIVE' }],
    user: {
      findUniqueOrThrow: async () => ({ role: 'OWNER' }),
      findUnique: async () => ({
        role: 'MEMBER',
        isActive: true,
        mustChangePassword: false,
      }),
    },
    departmentMembership: {
      findFirst: async () => null,
      findUnique: async () => {
        wait('read');
        return revoked ? row : null;
      },
      findMany: async () => {
        wait('list');
        return [row];
      },
      create: async () => {
        draft.push('membership');
        wait('membership');
        return row;
      },
    },
    systemSetting: { findFirst: async () => ({ id: 'synthetic-settings' }) },
    authSession: {
      findUnique: async () =>
        deadline === null ? null : { expiresAt: new Date(deadline) },
    },
    membershipEvent: {
      findFirst: async () => null,
      create: async () => {
        draft.push('audit');
        wait('audit');
        return { id: 'synthetic-audit' };
      },
    },
  };
  const db = {
    $transaction: async (work) => {
      draft = [];
      const result = await work(tx);
      committed.push(...draft);
      return result;
    },
  };
  const service = new DepartmentMembershipsService(db, {
    assertActiveSystemActor: async () => {},
  });
  return {
    clock,
    committed,
    run: () =>
      service.change(
        actor,
        row.departmentId,
        row.userId,
        revoked ? 'REVOKE' : 'CREATE',
        revoked ? undefined : grant,
        '"0"',
        'synthetic-key',
      ),
    list: () => service.list(actor, row.departmentId, { limit: 10 }),
  };
}
async function withClock(f, run) {
  const saved = Date.now;
  Date.now = f.clock;
  try {
    await run();
  } finally {
    Date.now = saved;
  }
}
test('expiry during membership or audit write rejects inside transaction and rolls back fake writes', async () => {
  for (const advanceAt of ['membership', 'audit']) {
    const f = fixture({ advanceAt });
    await withClock(f, async () => {
      await assert.rejects(f.run(), /Invalid session/);
      assert.deepEqual(f.committed, []);
    });
  }
});
test('live family preserves successful membership plus audit commit', async () => {
  const f = fixture();
  await withClock(f, async () => {
    assert.equal((await f.run()).userId, 'synthetic-target');
    assert.deepEqual(f.committed, ['membership', 'audit']);
  });
});
test('expired list and already-revoked responses deny after read waits', async () => {
  for (const options of [
    { advanceAt: 'list' },
    { advanceAt: 'read', revoked: true },
  ]) {
    const f = fixture(options);
    await withClock(f, async () => {
      await assert.rejects(
        options.revoked ? f.run() : f.list(),
        /Invalid session/,
      );
      assert.deepEqual(f.committed, []);
    });
  }
});
test('missing or invalid family expiry fails closed', async () => {
  for (const deadline of [null, NaN]) {
    const f = fixture({ deadline });
    await withClock(f, async () => {
      await assert.rejects(f.run(), /Invalid session/);
      assert.deepEqual(f.committed, []);
    });
  }
});
