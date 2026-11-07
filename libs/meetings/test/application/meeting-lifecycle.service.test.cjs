'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  MeetingLifecycleService,
} = require('../../src/application/meeting-lifecycle.service.ts');
const {
  MeetingLifecyclePolicy,
} = require('../../src/domain/meeting-lifecycle.policy.ts');

class InMemoryMeetingLifecycleRepository {
  constructor(initialMeetings = []) {
    this.meetings = new Map();
    for (const m of initialMeetings) {
      this.meetings.set(m.meetingId, { ...m });
    }
    this.loadCalls = 0;
    this.applyCalls = 0;
    this.hooks = {};
  }

  async loadMeetingRecord(meetingId) {
    this.loadCalls += 1;
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    return { ...m };
  }

  async applyTransition(meetingId, command) {
    this.applyCalls += 1;
    if (this.hooks.onBeforeApply) {
      await this.hooks.onBeforeApply(meetingId, command, this);
    }
    const current = this.meetings.get(meetingId);
    if (!current) {
      return { ok: false, label: 'GONE' };
    }
    if (current.lifecycleStatus !== command.expectedLifecycle) {
      return {
        ok: false,
        label: 'STATE_DIVERGED',
        currentLifecycle: current.lifecycleStatus,
        currentScheduleVersion: current.scheduleVersion,
      };
    }
    if (current.scheduleVersion !== command.expectedScheduleVersion) {
      return {
        ok: false,
        label: 'VERSION_MISMATCH',
        currentLifecycle: current.lifecycleStatus,
        currentScheduleVersion: current.scheduleVersion,
      };
    }

    const next = { ...current };
    next.lifecycleStatus = command.targetLifecycle;
    if (command.bumpScheduleVersion) {
      next.scheduleVersion += 1;
    }
    if (command.newScheduledAtUtc !== undefined) {
      next.scheduledAtUtc = command.newScheduledAtUtc;
    }
    if (command.newMeetUrl !== undefined) {
      next.meetUrl = command.newMeetUrl;
    }

    this.meetings.set(meetingId, next);
    return { ok: true, meeting: { ...next } };
  }
}

const VALID_MEET_URL = 'https://meet.google.com/abc-defg-hij';
const VALID_INSTANT = '2026-10-27T10:00:00Z';
const RESCHEDULED_INSTANT = '2026-10-27T14:00:00Z';

function createDraftMeeting(overrides = {}) {
  return {
    meetingId: 'm-1',
    meetingKind: 'TECH',
    departmentId: 'dept-tech',
    lifecycleStatus: 'DRAFT',
    scheduleVersion: 0,
    meetUrl: null,
    scheduledAtUtc: null,
    captureStatus: 'NOT_REQUESTED',
    createdById: 'u-creator',
    meetingAdminId: 'u-ma',
    ...overrides,
  };
}

function createScheduledMeeting(overrides = {}) {
  return createDraftMeeting({
    lifecycleStatus: 'SCHEDULED',
    scheduleVersion: 1,
    meetUrl: VALID_MEET_URL,
    scheduledAtUtc: VALID_INSTANT,
    ...overrides,
  });
}

function createInProgressMeeting(overrides = {}) {
  return createScheduledMeeting({
    lifecycleStatus: 'IN_PROGRESS',
    captureStatus: 'CAPTURING',
    ...overrides,
  });
}

function buildService(initialMeetings = []) {
  const repo = new InMemoryMeetingLifecycleRepository(initialMeetings);
  const service = new MeetingLifecycleService(
    repo,
    new MeetingLifecyclePolicy(),
  );
  return { repo, service };
}

const guardedTransitions = [
  [
    'schedule',
    createDraftMeeting,
    () => ({
      actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
      scheduledAtUtc: VALID_INSTANT,
      meetUrl: VALID_MEET_URL,
    }),
  ],
  [
    'reschedule',
    createScheduledMeeting,
    () => ({
      actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
      scheduledAtUtc: RESCHEDULED_INSTANT,
    }),
  ],
  [
    'startCapture',
    createScheduledMeeting,
    () => ({ systemAuthorized: true, claimedScheduleVersion: 1 }),
  ],
  ['endCapture', createInProgressMeeting, () => ({ systemAuthorized: true })],
  [
    'manualEnd',
    createInProgressMeeting,
    () => ({
      actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
      reason: 'Synthetic operational reason',
    }),
  ],
  [
    'adminStop',
    createInProgressMeeting,
    () => ({
      actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
      reason: 'Synthetic operational reason',
    }),
  ],
  [
    'adminCancel',
    createDraftMeeting,
    () => ({
      actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
      reason: 'Synthetic operational reason',
    }),
  ],
];
for (const [method, seed, request] of guardedTransitions)
  for (const field of ['meetingId', 'lifecycleStatus', 'scheduleVersion']) {
    test(`${method} rejects an unbound committed ${field}`, async () => {
      const initial = seed(),
        { repo, service } = buildService([initial]);
      const apply = repo.applyTransition.bind(repo);
      repo.applyTransition = async (id, command) => {
        const result = await apply(id, command);
        assert.equal(result.ok, true);
        return {
          ...result,
          meeting: {
            ...result.meeting,
            [field]:
              field === 'meetingId'
                ? 'synthetic-foreign'
                : field === 'lifecycleStatus'
                  ? result.meeting.lifecycleStatus === 'DRAFT'
                    ? 'ENDED'
                    : 'DRAFT'
                  : 42,
          },
        };
      };
      await assert.rejects(
        service[method](initial.meetingId, request()),
        /meeting-lifecycle-row-mapping-corrupt/,
      );
    });
  }

test('SCHEDULE: transitions DRAFT to SCHEDULED, sets instant & url, bumps version', async () => {
  const draft = createDraftMeeting();
  const { repo, service } = buildService([draft]);

  const outcome = await service.schedule('m-1', {
    actor: {
      userId: 'u-ma',
      systemRole: 'MEMBER',
      meetingRole: 'MEETING_ADMIN',
    },
    scheduledAtUtc: VALID_INSTANT,
    meetUrl: VALID_MEET_URL,
  });

  assert.equal(outcome.kind, 'TRANSITIONED');
  assert.equal(outcome.from, 'DRAFT');
  assert.equal(outcome.to, 'SCHEDULED');
  assert.equal(outcome.meeting.scheduleVersion, 1);
  assert.equal(outcome.meeting.scheduledAtUtc, VALID_INSTANT);
  assert.equal(outcome.meeting.meetUrl, VALID_MEET_URL);
  assert.equal(outcome.invalidateStaleJobs, true);
});

test('SCHEDULE: refused when meeting is already SCHEDULED', async () => {
  const scheduled = createScheduledMeeting();
  const { service } = buildService([scheduled]);

  const outcome = await service.schedule('m-1', {
    actor: { userId: 'u-owner', systemRole: 'OWNER' },
    scheduledAtUtc: VALID_INSTANT,
    meetUrl: VALID_MEET_URL,
  });

  assert.equal(outcome.kind, 'REFUSED');
  assert.equal(outcome.policyReason, 'ILLEGAL_TRANSITION');
});

test('RESCHEDULE: updates scheduledAtUtc, keeps SCHEDULED, bumps version', async () => {
  const scheduled = createScheduledMeeting();
  const { repo, service } = buildService([scheduled]);

  const outcome = await service.reschedule('m-1', {
    actor: {
      userId: 'u-da',
      systemRole: 'MEMBER',
      departmentId: 'dept-tech',
      departmentRole: 'ADMIN',
    },
    scheduledAtUtc: RESCHEDULED_INSTANT,
  });

  assert.equal(outcome.kind, 'TRANSITIONED');
  assert.equal(outcome.from, 'SCHEDULED');
  assert.equal(outcome.to, 'SCHEDULED');
  assert.equal(outcome.meeting.scheduleVersion, 2);
  assert.equal(outcome.meeting.scheduledAtUtc, RESCHEDULED_INSTANT);
  assert.equal(outcome.invalidateStaleJobs, true);
});

test('RESCHEDULE: refused on DRAFT meeting', async () => {
  const draft = createDraftMeeting();
  const { service } = buildService([draft]);

  const outcome = await service.reschedule('m-1', {
    actor: { userId: 'u-owner', systemRole: 'OWNER' },
    scheduledAtUtc: RESCHEDULED_INSTANT,
  });

  assert.equal(outcome.kind, 'REFUSED');
  assert.equal(outcome.policyReason, 'ILLEGAL_TRANSITION');
});

test('START_CAPTURE: moves SCHEDULED to IN_PROGRESS when scheduleVersion matches', async () => {
  const scheduled = createScheduledMeeting();
  const { service } = buildService([scheduled]);

  const outcome = await service.startCapture('m-1', {
    claimedScheduleVersion: 1,
    systemAuthorized: true,
  });

  assert.equal(outcome.kind, 'TRANSITIONED');
  assert.equal(outcome.from, 'SCHEDULED');
  assert.equal(outcome.to, 'IN_PROGRESS');
  assert.equal(outcome.meeting.scheduleVersion, 1);
});

test('START_CAPTURE: refused when claimedScheduleVersion does not match (FM-13 stale job)', async () => {
  const scheduled = createScheduledMeeting({ scheduleVersion: 2 });
  const { service } = buildService([scheduled]);

  const outcome = await service.startCapture('m-1', {
    claimedScheduleVersion: 1,
    systemAuthorized: true,
  });

  assert.equal(outcome.kind, 'REFUSED');
  assert.equal(outcome.policyReason, 'STALE_SCHEDULE');
});

test('START_CAPTURE: refused when unauthorized', async () => {
  const scheduled = createScheduledMeeting();
  const { service } = buildService([scheduled]);

  const outcome = await service.startCapture('m-1', {
    claimedScheduleVersion: 1,
    systemAuthorized: false,
    actor: { userId: 'u-mem', systemRole: 'MEMBER' },
  });

  assert.equal(outcome.kind, 'REFUSED_DOWNSTREAM');
  assert.equal(outcome.label, 'UNAUTHORIZED');
});

test('CAPTURE_ENDED: moves IN_PROGRESS to ENDED', async () => {
  const inProgress = createInProgressMeeting();
  const { service } = buildService([inProgress]);

  const outcome = await service.endCapture('m-1', {
    systemAuthorized: true,
  });

  assert.equal(outcome.kind, 'TRANSITIONED');
  assert.equal(outcome.from, 'IN_PROGRESS');
  assert.equal(outcome.to, 'ENDED');
});

test('CAPTURE_ENDED: late event on already ENDED meeting is rejected as LATE_CAPTURE_EVENT', async () => {
  const ended = createInProgressMeeting({ lifecycleStatus: 'ENDED' });
  const { service } = buildService([ended]);

  const outcome = await service.endCapture('m-1', {
    systemAuthorized: true,
  });

  assert.equal(outcome.kind, 'REFUSED');
  assert.equal(outcome.policyReason, 'LATE_CAPTURE_EVENT');
});

test('MANUAL_END: authorized meeting admin ends IN_PROGRESS meeting', async () => {
  const inProgress = createInProgressMeeting();
  const { service } = buildService([inProgress]);

  const outcome = await service.manualEnd('m-1', {
    actor: {
      userId: 'u-ma',
      systemRole: 'MEMBER',
      meetingRole: 'MEETING_ADMIN',
    },
  });

  assert.equal(outcome.kind, 'TRANSITIONED');
  assert.equal(outcome.from, 'IN_PROGRESS');
  assert.equal(outcome.to, 'ENDED');
  assert.equal(outcome.stopCapture, false);
});

test('ADMIN_STOP: moves IN_PROGRESS to ENDED with reason, stops capture, preserves partial evidence', async () => {
  const inProgress = createInProgressMeeting();
  const { service } = buildService([inProgress]);

  const outcome = await service.adminStop('m-1', {
    actor: { userId: 'u-owner', systemRole: 'OWNER' },
    reason: 'Emergency security stop',
  });

  assert.equal(outcome.kind, 'TRANSITIONED');
  assert.equal(outcome.from, 'IN_PROGRESS');
  assert.equal(outcome.to, 'ENDED');
  assert.equal(outcome.stopCapture, true);
  assert.equal(outcome.preservePartialEvidence, true);
});

test('ADMIN_STOP: empty reason throws invalid request', async () => {
  const inProgress = createInProgressMeeting();
  const { service } = buildService([inProgress]);

  await assert.rejects(
    () =>
      service.adminStop('m-1', {
        actor: { userId: 'u-owner', systemRole: 'OWNER' },
        reason: '   ',
      }),
    /^Error: meeting-lifecycle-invalid-request$/,
  );
});

test('ADMIN_CANCEL: cancels DRAFT meeting with reason, bumps version', async () => {
  const draft = createDraftMeeting();
  const { service } = buildService([draft]);

  const outcome = await service.adminCancel('m-1', {
    actor: { userId: 'u-mgr', systemRole: 'MANAGER' },
    reason: 'Meeting no longer required',
  });

  assert.equal(outcome.kind, 'TRANSITIONED');
  assert.equal(outcome.from, 'DRAFT');
  assert.equal(outcome.to, 'CANCELLED');
  assert.equal(outcome.meeting.scheduleVersion, 1);
});

test('ADMIN_CANCEL: cancels SCHEDULED meeting with reason, bumps version, invalidates jobs', async () => {
  const scheduled = createScheduledMeeting();
  const { service } = buildService([scheduled]);

  const outcome = await service.adminCancel('m-1', {
    actor: {
      userId: 'u-da',
      systemRole: 'MEMBER',
      departmentId: 'dept-tech',
      departmentRole: 'ADMIN',
    },
    reason: 'Client cancelled',
  });

  assert.equal(outcome.kind, 'TRANSITIONED');
  assert.equal(outcome.from, 'SCHEDULED');
  assert.equal(outcome.to, 'CANCELLED');
  assert.equal(outcome.meeting.scheduleVersion, 2);
  assert.equal(outcome.invalidateStaleJobs, true);
});

test('ADMIN_CANCEL: cancellation of IN_PROGRESS meeting produces ENDED per MW-043', async () => {
  const inProgress = createInProgressMeeting();
  const { service } = buildService([inProgress]);

  const outcome = await service.adminCancel('m-1', {
    actor: { userId: 'u-owner', systemRole: 'OWNER' },
    reason: 'Host cancelled mid-call',
  });

  assert.equal(outcome.kind, 'TRANSITIONED');
  assert.equal(outcome.from, 'IN_PROGRESS');
  assert.equal(outcome.to, 'ENDED');
  assert.equal(outcome.stopCapture, true);
  assert.equal(outcome.preservePartialEvidence, true);
});

test('terminal state: cannot cancel an already ENDED meeting (ALREADY_ENDED)', async () => {
  const ended = createInProgressMeeting({ lifecycleStatus: 'ENDED' });
  const { service } = buildService([ended]);

  const outcome = await service.adminCancel('m-1', {
    actor: { userId: 'u-owner', systemRole: 'OWNER' },
    reason: 'Trying to cancel after end',
  });

  assert.equal(outcome.kind, 'REFUSED');
  assert.equal(outcome.policyReason, 'ALREADY_ENDED');
});

test('terminal state: cannot resurrect a CANCELLED meeting (NO_RESURRECTION)', async () => {
  const cancelled = createDraftMeeting({ lifecycleStatus: 'CANCELLED' });
  const { service } = buildService([cancelled]);

  const outcome = await service.schedule('m-1', {
    actor: { userId: 'u-owner', systemRole: 'OWNER' },
    scheduledAtUtc: VALID_INSTANT,
    meetUrl: VALID_MEET_URL,
  });

  assert.equal(outcome.kind, 'REFUSED');
  assert.equal(outcome.policyReason, 'NO_RESURRECTION');
});

test('authorization: DepartmentRole ADMIN of DIFFERENT department is refused', async () => {
  const draft = createDraftMeeting({ departmentId: 'dept-tech' });
  const { service } = buildService([draft]);

  const outcome = await service.schedule('m-1', {
    actor: {
      userId: 'u-da-sales',
      systemRole: 'MEMBER',
      departmentId: 'dept-sales',
      departmentRole: 'ADMIN',
    },
    scheduledAtUtc: VALID_INSTANT,
    meetUrl: VALID_MEET_URL,
  });

  assert.equal(outcome.kind, 'REFUSED_DOWNSTREAM');
  assert.equal(outcome.label, 'UNAUTHORIZED');
});

test('authorization: DepartmentRole ADMIN cannot manage GENERAL meeting', async () => {
  const general = createDraftMeeting({
    meetingKind: 'GENERAL',
    departmentId: null,
  });
  const { service } = buildService([general]);

  const outcome = await service.schedule('m-1', {
    actor: {
      userId: 'u-da',
      systemRole: 'MEMBER',
      departmentId: 'dept-tech',
      departmentRole: 'ADMIN',
    },
    scheduledAtUtc: VALID_INSTANT,
    meetUrl: VALID_MEET_URL,
  });

  assert.equal(outcome.kind, 'REFUSED_DOWNSTREAM');
  assert.equal(outcome.label, 'UNAUTHORIZED');
});

test('authorization: regular MEMBER without meeting admin role is refused', async () => {
  const draft = createDraftMeeting();
  const { service } = buildService([draft]);

  const outcome = await service.schedule('m-1', {
    actor: { userId: 'u-mem', systemRole: 'MEMBER' },
    scheduledAtUtc: VALID_INSTANT,
    meetUrl: VALID_MEET_URL,
  });

  assert.equal(outcome.kind, 'REFUSED_DOWNSTREAM');
  assert.equal(outcome.label, 'UNAUTHORIZED');
});

test('concurrency: concurrent reschedule race - loser receives VERSION_MISMATCH', async () => {
  const scheduled = createScheduledMeeting();
  const { service } = buildService([scheduled]);

  const [res1, res2] = await Promise.all([
    service.reschedule('m-1', {
      actor: { userId: 'u-owner', systemRole: 'OWNER' },
      scheduledAtUtc: '2026-10-27T12:00:00Z',
    }),
    service.reschedule('m-1', {
      actor: { userId: 'u-owner', systemRole: 'OWNER' },
      scheduledAtUtc: '2026-10-27T14:00:00Z',
    }),
  ]);

  const transitioned = [res1, res2].filter((r) => r.kind === 'TRANSITIONED');
  const refused = [res1, res2].filter((r) => r.kind === 'REFUSED_DOWNSTREAM');

  assert.equal(transitioned.length, 1);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].label, 'VERSION_MISMATCH');
});

test('concurrency: reschedule vs cancel race - loser receives VERSION_MISMATCH or STATE_DIVERGED', async () => {
  const scheduled = createScheduledMeeting();
  const { service } = buildService([scheduled]);

  const [res1, res2] = await Promise.all([
    service.reschedule('m-1', {
      actor: { userId: 'u-owner', systemRole: 'OWNER' },
      scheduledAtUtc: RESCHEDULED_INSTANT,
    }),
    service.adminCancel('m-1', {
      actor: { userId: 'u-owner', systemRole: 'OWNER' },
      reason: 'Cancel racing against reschedule',
    }),
  ]);

  const outcomes = [res1.kind, res2.kind].sort();
  assert.deepEqual(outcomes, ['REFUSED_DOWNSTREAM', 'TRANSITIONED']);
});

test('shape: invalid Google Meet URL throws invalid request', async () => {
  const draft = createDraftMeeting();
  const { service } = buildService([draft]);

  await assert.rejects(
    () =>
      service.schedule('m-1', {
        actor: { userId: 'u-owner', systemRole: 'OWNER' },
        scheduledAtUtc: VALID_INSTANT,
        meetUrl: 'https://zoom.us/j/123456789',
      }),
    /^Error: meeting-lifecycle-invalid-request$/,
  );
});

test('shape: invalid ISO instant throws invalid request', async () => {
  const draft = createDraftMeeting();
  const { service } = buildService([draft]);

  await assert.rejects(
    () =>
      service.schedule('m-1', {
        actor: { userId: 'u-owner', systemRole: 'OWNER' },
        scheduledAtUtc: 'not-a-date',
        meetUrl: VALID_MEET_URL,
      }),
    /^Error: meeting-lifecycle-invalid-request$/,
  );
});

test('store: missing meeting throws race-lost', async () => {
  const { service } = buildService([]);

  await assert.rejects(
    () =>
      service.schedule('m-nonexistent', {
        actor: { userId: 'u-owner', systemRole: 'OWNER' },
        scheduledAtUtc: VALID_INSTANT,
        meetUrl: VALID_MEET_URL,
      }),
    /^Error: meeting-lifecycle-race-lost$/,
  );
});

test('record integrity: mismatched meetingId throws corrupt mapping', async () => {
  const badMeeting = createDraftMeeting({ meetingId: 'm-different' });
  const repo = new InMemoryMeetingLifecycleRepository();
  repo.meetings.set('m-1', badMeeting);
  const service = new MeetingLifecycleService(repo);

  await assert.rejects(
    () =>
      service.schedule('m-1', {
        actor: { userId: 'u-owner', systemRole: 'OWNER' },
        scheduledAtUtc: VALID_INSTANT,
        meetUrl: VALID_MEET_URL,
      }),
    /^Error: meeting-lifecycle-row-mapping-corrupt$/,
  );
});

test('record integrity: negative or float scheduleVersion throws corrupt mapping', async () => {
  const badMeeting = createDraftMeeting({ scheduleVersion: -1 });
  const { service } = buildService([badMeeting]);

  await assert.rejects(
    () =>
      service.schedule('m-1', {
        actor: { userId: 'u-owner', systemRole: 'OWNER' },
        scheduledAtUtc: VALID_INSTANT,
        meetUrl: VALID_MEET_URL,
      }),
    /^Error: meeting-lifecycle-row-mapping-corrupt$/,
  );
});

test('actor validation: invalid systemRole throws invalid request', async () => {
  const draft = createDraftMeeting();
  const { service } = buildService([draft]);

  await assert.rejects(
    () =>
      service.schedule('m-1', {
        actor: { userId: 'u-bad', systemRole: 'SUPERADMIN' },
        scheduledAtUtc: VALID_INSTANT,
        meetUrl: VALID_MEET_URL,
      }),
    /^Error: meeting-lifecycle-invalid-request$/,
  );
});

test('actor validation: invalid meetingRole throws invalid request', async () => {
  const draft = createDraftMeeting();
  const { service } = buildService([draft]);

  await assert.rejects(
    () =>
      service.schedule('m-1', {
        actor: { userId: 'u-bad', systemRole: 'MEMBER', meetingRole: 'HACKER' },
        scheduledAtUtc: VALID_INSTANT,
        meetUrl: VALID_MEET_URL,
      }),
    /^Error: meeting-lifecycle-invalid-request$/,
  );
});

test('actor authorization: user matching meetingAdminId is authorized even without explicit meetingRole', async () => {
  const draft = createDraftMeeting({ meetingAdminId: 'u-special-admin' });
  const { service } = buildService([draft]);

  const outcome = await service.schedule('m-1', {
    actor: { userId: 'u-special-admin', systemRole: 'MEMBER' },
    scheduledAtUtc: VALID_INSTANT,
    meetUrl: VALID_MEET_URL,
  });

  assert.equal(outcome.kind, 'TRANSITIONED');
  assert.equal(outcome.meeting.lifecycleStatus, 'SCHEDULED');
});

test('actor authorization: REVIEWER/APPROVER/VIEWER role is refused manage operations', async () => {
  const draft = createDraftMeeting();
  const { service } = buildService([draft]);

  for (const nonAdminRole of ['REVIEWER', 'APPROVER', 'VIEWER']) {
    const outcome = await service.schedule('m-1', {
      actor: {
        userId: 'u-reviewer',
        systemRole: 'MEMBER',
        meetingRole: nonAdminRole,
      },
      scheduledAtUtc: VALID_INSTANT,
      meetUrl: VALID_MEET_URL,
    });

    assert.equal(outcome.kind, 'REFUSED_DOWNSTREAM');
    assert.equal(outcome.label, 'UNAUTHORIZED');
  }
});

test('actor authorization: OWNER or MANAGER can manage GENERAL meeting', async () => {
  const general = createDraftMeeting({
    meetingKind: 'GENERAL',
    departmentId: null,
  });
  const { service } = buildService([general]);

  const outcomeOwner = await service.schedule('m-1', {
    actor: { userId: 'u-owner', systemRole: 'OWNER' },
    scheduledAtUtc: VALID_INSTANT,
    meetUrl: VALID_MEET_URL,
  });
  assert.equal(outcomeOwner.kind, 'TRANSITIONED');

  const outcomeMgr = await service.reschedule('m-1', {
    actor: { userId: 'u-mgr', systemRole: 'MANAGER' },
    scheduledAtUtc: RESCHEDULED_INSTANT,
  });
  assert.equal(outcomeMgr.kind, 'TRANSITIONED');
});

test('startCapture / endCapture: OWNER actor can trigger capture without systemAuthorized flag', async () => {
  const scheduled = createScheduledMeeting();
  const { service } = buildService([scheduled]);

  const startOutcome = await service.startCapture('m-1', {
    claimedScheduleVersion: 1,
    actor: { userId: 'u-owner', systemRole: 'OWNER' },
  });
  assert.equal(startOutcome.kind, 'TRANSITIONED');
  assert.equal(startOutcome.meeting.lifecycleStatus, 'IN_PROGRESS');

  const endOutcome = await service.endCapture('m-1', {
    actor: { userId: 'u-owner', systemRole: 'OWNER' },
  });
  assert.equal(endOutcome.kind, 'TRANSITIONED');
  assert.equal(endOutcome.meeting.lifecycleStatus, 'ENDED');
});

test('startCapture: invalid claimedScheduleVersion throws invalid request', async () => {
  const scheduled = createScheduledMeeting();
  const { service } = buildService([scheduled]);

  await assert.rejects(
    () =>
      service.startCapture('m-1', {
        claimedScheduleVersion: -1,
        systemAuthorized: true,
      }),
    /^Error: meeting-lifecycle-invalid-request$/,
  );

  await assert.rejects(
    () =>
      service.startCapture('m-1', {
        claimedScheduleVersion: 1.5,
        systemAuthorized: true,
      }),
    /^Error: meeting-lifecycle-invalid-request$/,
  );
});

test('reschedule: updates meetUrl if new URL is provided', async () => {
  const scheduled = createScheduledMeeting();
  const NEW_URL = 'https://meet.google.com/xyz-uvwx-rst';
  const { service } = buildService([scheduled]);

  const outcome = await service.reschedule('m-1', {
    actor: { userId: 'u-owner', systemRole: 'OWNER' },
    scheduledAtUtc: RESCHEDULED_INSTANT,
    meetUrl: NEW_URL,
  });

  assert.equal(outcome.kind, 'TRANSITIONED');
  assert.equal(outcome.meeting.meetUrl, NEW_URL);
});

test('downstream error: applyTransition returns ACTIVE_CAPTURE_CONFLICT', async () => {
  const scheduled = createScheduledMeeting();
  const repo = new InMemoryMeetingLifecycleRepository([scheduled]);
  repo.applyTransition = async () => ({
    ok: false,
    label: 'ACTIVE_CAPTURE_CONFLICT',
  });
  const service = new MeetingLifecycleService(repo);

  const outcome = await service.reschedule('m-1', {
    actor: { userId: 'u-owner', systemRole: 'OWNER' },
    scheduledAtUtc: RESCHEDULED_INSTANT,
  });

  assert.equal(outcome.kind, 'REFUSED_DOWNSTREAM');
  assert.equal(outcome.label, 'ACTIVE_CAPTURE_CONFLICT');
});

test('adminCancel: whitespace reason throws invalid request', async () => {
  const draft = createDraftMeeting();
  const { service } = buildService([draft]);

  await assert.rejects(
    () =>
      service.adminCancel('m-1', {
        actor: { userId: 'u-owner', systemRole: 'OWNER' },
        reason: '   \t\n  ',
      }),
    /^Error: meeting-lifecycle-invalid-request$/,
  );
});

test('empty meetingId throws invalid request across methods', async () => {
  const { service } = buildService([]);

  await assert.rejects(
    () =>
      service.schedule('   ', {
        actor: { userId: 'u-owner', systemRole: 'OWNER' },
        scheduledAtUtc: VALID_INSTANT,
        meetUrl: VALID_MEET_URL,
      }),
    /^Error: meeting-lifecycle-invalid-request$/,
  );
});
