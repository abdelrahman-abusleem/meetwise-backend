require('../register-meeting-tests.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ActorAuthorityService,
} = require('../../apps/api/src/modules/auth/services/actor-authority.service.ts');
const {
  DepartmentModulesService,
} = require('../../apps/api/src/modules/system-settings/department-modules.service.ts');
const {
  AccountProvisioningService,
} = require('../../apps/api/src/modules/auth/account-provisioning.service.ts');
const {
  AdministrativeResetService,
} = require('../../apps/api/src/modules/auth/administrative-reset.service.ts');
const {
  WizardDraftsService,
} = require('../../apps/api/src/modules/setup/wizard-drafts.service.ts');
const actorId = '11111111-1111-4111-8111-111111111111';
const targetId = '22222222-2222-4222-8222-222222222222';
const familyId = '33333333-3333-4333-8333-333333333333';
const departmentId = '44444444-4444-4444-8444-444444444444';
const draftId = '55555555-5555-4555-8555-555555555555';
const actor = { id: actorId, familyId, tokenVersion: 1, role: 'OWNER' };
const cases = [
  ['module-create', 'module.audit'],
  ['module-active', 'module.read'],
  ['module-reactivate', 'module.audit'],
  ['module-race', 'module.reread'],
  ['provision', 'activation.audit'],
  ['replace', 'activation.audit'],
  ['revoke', 'activation.audit'],
  ['revoke-noop', 'activation.read'],
  ['reset-issue', 'reset.audit'],
  ['draft-create', 'draft.audit'],
  ['draft-get', 'draft.read'],
  ['draft-update', 'draft.audit'],
];

function harness(name, point, fault) {
  let now = 1000,
    touched = false,
    draft = [],
    committed = [];
  const authorityState = {
    active: true,
    role: 'OWNER',
    epoch: 1,
    revoked: false,
  };
  const trace = [];
  function wait(label) {
    if (label !== point || touched) return;
    touched = true;
    if (fault === 'expired') now = 1010;
    if (fault === 'revoked') authorityState.revoked = true;
    if (fault === 'inactive') authorityState.active = false;
    if (fault === 'epoch') authorityState.epoch = 2;
    if (fault === 'role') authorityState.role = 'MEMBER';
    if (fault === 'write-error')
      throw new Error('Synthetic persistence failure');
  }
  function persist(label, result) {
    draft.push(label);
    wait(label);
    return result;
  }
  const pending = {
    id: targetId,
    role: 'MEMBER',
    isActive: false,
    mustChangePassword: true,
    tokenVersion: 0,
    email: 'synthetic@example.invalid',
    name: 'Synthetic',
  };
  const state = {
    targetRole: 'MEMBER',
    consumedAt: null,
    revokedAt: name === 'revoke-noop' ? new Date(900) : null,
  };
  const module = {
    id: departmentId,
    kind: 'TECH',
    status: name === 'module-active' ? 'ACTIVE' : 'DISABLED',
    version: 1,
  };
  const wizard = {
    id: draftId,
    actorId,
    version: 1,
    data: {},
    createdAt: new Date(1000),
    lastActivityAt: new Date(1000),
    expiresAt: new Date(100000),
    completedAt: null,
  };
  const tx = {
    $queryRaw: async (parts) => {
      const sql = parts.join('');
      if (sql.includes('FROM auth_sessions')) {
        trace.push('family');
        return [
          {
            expiresAt: new Date(1005),
            revokedAt: authorityState.revoked ? new Date(1001) : null,
            tokenVersion: 1,
          },
        ];
      }
      if (sql.includes('FROM users')) {
        trace.push('users');
        return [
          {
            id: actorId,
            role: authorityState.role,
            isActive: authorityState.active,
            mustChangePassword: false,
            tokenVersion: authorityState.epoch,
          },
        ];
      }
      if (sql.includes('INSERT INTO departments'))
        return name === 'module-create'
          ? [persist('module.insert', { ...module, status: 'ACTIVE' })]
          : [];
      if (sql.includes('FROM setup_drafts')) return [{ id: draftId }];
      if (sql.includes('FROM system_settings')) return [{ id: 'system' }];
      throw new Error('Unplanned synthetic SQL');
    },
    authSession: { findUnique: async () => ({ expiresAt: new Date(1005) }) },
    systemSetting: {
      findFirst: async () => ({ id: 'system' }),
      findUnique: async () => ({
        setupCompleted: true,
        wizardCompletedAt: null,
      }),
    },
    department: {
      findUniqueOrThrow: async () => {
        const reread = draft.includes('module.flip');
        wait(reread ? 'module.reread' : 'module.read');
        return reread ? { ...module, status: 'ACTIVE' } : module;
      },
      updateMany: async () =>
        persist('module.flip', { count: name === 'module-race' ? 0 : 1 }),
    },
    departmentActivationEvent: {
      create: async () => persist('module.audit', {}),
    },
    user: {
      findUniqueOrThrow: async () => ({
        id: actorId,
        role: 'OWNER',
        tokenVersion: 1,
      }),
      findFirst: async () => null,
      findUnique: async () =>
        name === 'reset-issue' ? { ...pending, isActive: true } : pending,
      create: async () => persist('activation.user', pending),
      update: async () =>
        persist('user.update', { ...pending, tokenVersion: 1 }),
    },
    activationToken: {
      findUnique: async () => state,
      findUniqueOrThrow: async () => {
        wait('activation.read');
        return state;
      },
      upsert: async () => persist('activation.token', {}),
      update: async () => persist('activation.revoke', {}),
    },
    activationEvent: {
      findFirst: async () => null,
      create: async () => persist('activation.audit', {}),
    },
    administrativeResetToken: {
      upsert: async () => persist('reset.token', {}),
    },
    administrativeResetEvent: {
      findFirst: async () => null,
      create: async () => persist('reset.audit', {}),
    },
    setupDraft: {
      create: async () => persist('draft.create', wizard),
      findUniqueOrThrow: async () => {
        wait('draft.read');
        return wizard;
      },
      update: async () => persist('draft.update', { ...wizard, version: 2 }),
    },
    setupDraftEvent: {
      findFirst: async () => null,
      create: async () => persist('draft.audit', {}),
    },
  };
  const db = {
    $transaction: async (work) => {
      draft = [];
      const result = await work(tx);
      committed = draft.slice();
      return result;
    },
  };
  const authority = new ActorAuthorityService();
  const passwords = { hash: async () => 'synthetic-unusable-hash' };
  let run;
  if (name.startsWith('module-'))
    run = () =>
      new DepartmentModulesService(db, authority).enable(actor, 'TECH');
  else if (name === 'reset-issue')
    run = () =>
      new AdministrativeResetService(db, authority, passwords).issue(
        actor,
        targetId,
        'synthetic-key',
      );
  else if (name.startsWith('draft-')) {
    const service = new WizardDraftsService(db, authority);
    run =
      name === 'draft-create'
        ? () => service.create(actor, {}, 'synthetic-key')
        : name === 'draft-get'
          ? () => service.get(actor, draftId)
          : () => service.update(actor, draftId, {}, '"1"', 'synthetic-key');
  } else {
    const service = new AccountProvisioningService(db, authority, passwords);
    run =
      name === 'provision'
        ? () =>
            service.provision(
              actor,
              {
                email: pending.email,
                name: pending.name,
                systemRole: 'MEMBER',
              },
              'synthetic-key',
            )
        : name === 'replace'
          ? () => service.replace(actor, targetId, 'synthetic-key')
          : () => service.revoke(actor, targetId);
  }
  return {
    run,
    now: () => now,
    committed: () => committed,
    touched: () => touched,
    trace,
  };
}
async function clock(h, callback) {
  const original = Date.now;
  Date.now = h.now;
  try {
    await callback();
  } finally {
    Date.now = original;
  }
}
for (const [name, point] of cases) {
  test(`${name}: expiry during awaited work prevents success and modeled commit`, async () => {
    const h = harness(name, point, 'expired');
    await clock(h, async () => {
      await assert.rejects(h.run(), /Invalid session/);
      assert.equal(h.touched(), true);
      assert.deepEqual(h.committed(), []);
      assert.deepEqual(h.trace.slice(0, 2), ['family', 'users']);
    });
  });
  test(`${name}: a current actor retains the existing success path`, async () => {
    const h = harness(name, point);
    await clock(h, async () => {
      await h.run();
      assert.equal(h.touched(), true);
    });
  });
}
for (const [name, point] of cases.filter(([name]) =>
  ['module-create', 'provision', 'reset-issue', 'draft-update'].includes(name),
)) {
  for (const fault of ['revoked', 'inactive', 'epoch', 'role'])
    test(`${name}: current ${fault} authority fact denies after awaited work`, async () => {
      const h = harness(name, point, fault);
      await clock(h, async () => {
        await assert.rejects(
          h.run(),
          /Invalid session|Insufficient system role/,
        );
        assert.deepEqual(h.committed(), []);
      });
    });
}
test('persistence failure stays visible and cannot become a success or modeled commit', async () => {
  const h = harness('provision', 'activation.audit', 'write-error');
  await clock(h, async () => {
    await assert.rejects(h.run(), /Synthetic persistence failure/);
    assert.deepEqual(h.committed(), []);
  });
});
