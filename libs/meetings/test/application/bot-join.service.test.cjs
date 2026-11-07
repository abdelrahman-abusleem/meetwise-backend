'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  BotJoinDispatchService,
} = require('../../src/application/bot-join.service.ts');
const {
  BotJoinEligibilityPolicy,
} = require('../../src/domain/bot-join-eligibility.policy.ts');

class InMemoryBotJoinRepository {
  constructor({ meetings, sessions, hooks = {} }) {
    this.meetings = meetings;
    this.sessions = sessions;
    this.hooks = hooks;
    this.loadJoinCalls = 0;
    this.claimCalls = 0;
    this.recordCalls = 0;
    this.loadRequeueCalls = 0;
    this.createCalls = 0;
    let nextRowId = 0;
    this.nextSessionId = () => `bs-${++nextRowId}`;
  }

  projectSession(row) {
    return { ...row, lastEventAt: row.lastEventAt ?? null };
  }

  projectMeetingOccurrence(meeting) {
    return {
      meetingId: meeting.meetingId,
      meetingKind: meeting.meetingKind,
      meetingLifecycle: meeting.meetingLifecycle,
      meetUrl: meeting.meetUrl,
      scheduledAtUtc: meeting.scheduledAtUtc,
      captureStatus: meeting.captureStatus,
      scheduleVersion: meeting.scheduleVersion,
      departmentId: meeting.departmentId,
      departmentActivationState: meeting.departmentActivationState,
      providerConnectionAuthorized: meeting.providerConnectionAuthorized,
      providerConfigEnabled: meeting.providerConfigEnabled,
      capturePrerequisitesVerified: meeting.capturePrerequisitesVerified,
    };
  }

  projectRequeueRecord(meeting) {
    return { occurrence: this.projectMeetingOccurrence(meeting) };
  }

  async loadJoinRecord(job) {
    this.loadJoinCalls += 1;
    const meeting = this.meetings.get(job.meetingId);
    if (!meeting) return null;
    const row = this.sessions.get(job.botSessionId) ?? null;
    return {
      ...this.projectMeetingOccurrence(meeting),
      sessionForJob: row ? { ...row } : null,
    };
  }

  async claimJoining(job) {
    this.claimCalls += 1;
    if (this.hooks.onBeforeClaim) this.hooks.onBeforeClaim(job, this);
    const row = this.sessions.get(job.botSessionId);
    if (!row) return { ok: false, label: 'GONE' };
    if (row.meetingId !== job.meetingId) {
      throw new Error('bot-join-row-mapping-corrupt');
    }
    const meeting = this.meetings.get(job.meetingId);
    if (!meeting) return { ok: false, label: 'GONE' };
    if (row.state !== 'QUEUED' || meeting.captureStatus !== 'QUEUED') {
      return { ok: false, label: 'NOT_QUEUED' };
    }
    if (row.idempotencyKey !== job.idempotencyKey) {
      return { ok: false, label: 'KEY_MISMATCH' };
    }
    if (row.scheduleVersionAtActivation !== meeting.scheduleVersion) {
      return { ok: false, label: 'STALE_VERSION' };
    }

    row.state = 'JOINING';
    meeting.captureStatus = 'JOINING';
    row.lastEventAt = '2026-10-27T10:01:00.001Z';
    return { ok: true, session: this.projectSession(row) };
  }

  async recordJoinAttemptOutcome(job, command) {
    this.recordCalls += 1;
    if (this.hooks.onBeforeRecord) this.hooks.onBeforeRecord(job, this);
    const row = this.sessions.get(job.botSessionId);
    if (!row) return { ok: false, label: 'GONE', currentState: null };
    const meeting = this.meetings.get(job.meetingId);
    if (
      row.state !== 'JOINING' ||
      !meeting ||
      meeting.captureStatus !== 'JOINING'
    ) {
      return {
        ok: false,
        label: 'NOT_JOINING',
        currentState: row.state,
      };
    }
    if (command.makeFailed) {
      row.state = 'FAILED';
      meeting.captureStatus = 'FAILED';
    }
    if (command.admissionState !== null) {
      row.admissionState = command.admissionState;
    }
    row.lastEventAt = '2026-10-27T10:01:00.002Z';
    return { ok: true, session: this.projectSession(row) };
  }

  async loadRequeueRecord(meetingId) {
    this.loadRequeueCalls += 1;
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return null;
    return this.projectRequeueRecord(meeting);
  }

  async createRetriggerAttempt(meetingId) {
    this.createCalls += 1;
    if (this.hooks.onBeforeCreate) this.hooks.onBeforeCreate(meetingId, this);
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return { ok: false, label: 'GONE' };
    if (
      meeting.captureStatus !== 'FAILED' &&
      meeting.captureStatus !== 'INTERRUPTED'
    ) {
      return { ok: false, label: 'NO_TERMINAL_CAPTURE' };
    }
    const sessionRows = [...this.sessions.values()].filter(
      (row) => row.meetingId === meetingId,
    );
    const active = sessionRows.filter(
      (row) =>
        row.state === 'QUEUED' ||
        row.state === 'JOINING' ||
        row.state === 'CAPTURING',
    );
    if (active.length > 0) {
      return { ok: false, label: 'ACTIVE_ATTEMPT_EXISTS' };
    }
    const attempt =
      sessionRows.reduce((m, row) => Math.max(m, row.attempt), 0) + 1;
    const generation = sessionRows.reduce(
      (m, row) => Math.max(m, row.captureGeneration),
      1,
    );
    const row = {
      id: this.nextSessionId(),
      meetingId,
      provider: 'vexa',
      state: 'QUEUED',
      attempt,
      idempotencyKey: `${meetingId}|g${generation}|a${attempt}`,
      captureGeneration: generation,
      scheduleVersionAtActivation: meeting.scheduleVersion,
      admissionState: null,
      externalSessionId: null,
      correlationKey: null,
      providerMetadataSafe: null,
      lastEventAt: '2026-10-27T11:00:00.001Z',
    };
    this.sessions.set(row.id, row);
    meeting.captureStatus = 'QUEUED';
    return { ok: true, session: this.projectSession(row) };
  }
}

class FakeBotProviderPort {
  constructor(outcomes) {
    this.outcomes = outcomes !== undefined ? [...outcomes] : undefined;
    this.calls = [];
  }
  async attemptJoin(payload) {
    this.calls.push({ ...payload });
    if (this.outcomes === undefined) return 'JOINING';
    if (this.outcomes.length === 0) {
      throw new Error('fake-provider-port-script-underflow');
    }
    return this.outcomes.shift();
  }
}

const MEET_URL = 'https://meet.google.com/abc-defg-hij';

function eligibleMeeting(overrides = {}) {
  return {
    meetingId: 'm-1',
    meetingKind: 'TECH',
    meetingLifecycle: 'SCHEDULED',
    meetUrl: MEET_URL,
    scheduledAtUtc: '2026-10-27T10:00:00Z',
    captureStatus: 'NOT_REQUESTED',
    scheduleVersion: 3,
    departmentId: 'dept-1',
    departmentActivationState: 'ACTIVE',
    providerConnectionAuthorized: true,
    providerConfigEnabled: true,
    capturePrerequisitesVerified: true,
    ...overrides,
  };
}

const CAPTURE_VOCAB = [
  'NOT_REQUESTED',
  'QUEUED',
  'JOINING',
  'CAPTURING',
  'COMPLETED',
  'FAILED',
  'INTERRUPTED',
];

function plantQueuedAttempt(repo, meeting, opts = {}) {
  const row = {
    id: repo.nextSessionId(),
    meetingId: opts.meetingId ?? meeting.meetingId,
    provider: 'vexa',
    state: opts.state ?? 'QUEUED',
    attempt: opts.attempt ?? 1,
    idempotencyKey:
      opts.idempotencyKey ??
      `${meeting.meetingId}|g${opts.captureGeneration ?? opts.generation ?? 1}|a${opts.attempt ?? 1}`,
    captureGeneration: opts.captureGeneration ?? opts.generation ?? 1,
    scheduleVersionAtActivation:
      opts.scheduleVersionAtActivation ?? meeting.scheduleVersion,
    admissionState: opts.admissionState ?? null,
    externalSessionId: opts.externalSessionId ?? null,
    correlationKey: opts.correlationKey ?? null,
    providerMetadataSafe: null,
    lastEventAt: null,
  };
  repo.sessions.set(row.id, row);
  if (
    !opts.keepCapture &&
    row.state !== 'NOT_REQUESTED' &&
    CAPTURE_VOCAB.indexOf(row.state) !== -1
  ) {
    meeting.captureStatus = row.state;
  }
  return row;
}

function jobFor(row) {
  return {
    meetingId: row.meetingId,
    botSessionId: row.id,
    idempotencyKey: row.idempotencyKey,
  };
}

const DISPATCH_AT = '2026-10-27T10:01:00Z';

function buildFixture(overrides = {}, hookNames) {
  const meeting = eligibleMeeting(overrides.meeting);
  const hooks = {};
  if (hookNames) for (const [k, v] of Object.entries(hookNames)) hooks[k] = v;
  const repo = new InMemoryBotJoinRepository({
    meetings: new Map([[meeting.meetingId, meeting]]),
    sessions: new Map(),
    hooks,
  });
  const row = plantQueuedAttempt(repo, meeting, overrides.attempt);
  const fakePort = new FakeBotProviderPort(overrides.portOutcomes);
  const service = new BotJoinDispatchService(
    repo,
    fakePort,
    new BotJoinEligibilityPolicy(),
  );
  return { service, repo, fakePort, meeting, row, job: jobFor(row) };
}

for (const [field, value] of [
  ['id', 'synthetic-foreign'],
  ['idempotencyKey', 'synthetic-other-key'],
  ['attempt', 42],
  ['captureGeneration', 42],
  ['scheduleVersionAtActivation', 42],
  ['provider', 'synthetic-other-provider'],
  ['state', 'CAPTURING'],
]) {
  test(`claimed bot ${field} is bound before any provider attempt`, async () => {
    const { repo, service, fakePort, job } = buildFixture();
    const claim = repo.claimJoining.bind(repo);
    repo.claimJoining = async (address) => {
      const result = await claim(address);
      assert.equal(result.ok, true);
      return { ...result, session: { ...result.session, [field]: value } };
    };
    await assert.rejects(
      service.dispatchFromDelivery(job, { dispatchAt: DISPATCH_AT }),
      /bot-join-row-mapping-corrupt/,
    );
    assert.equal(fakePort.calls.length, 0);
  });
}

function assertMutatedNothingYet(repo) {
  assert.equal(repo.claimCalls, 0);
  assert.equal(repo.recordCalls, 0);
  assert.equal(repo.createCalls, 0);
}

test('a malformed job address refuses before touching the store', async () => {
  const { service, repo } = buildFixture();
  await assert.rejects(
    () =>
      service.dispatchFromDelivery(
        { meetingId: 'm-1', botSessionId: 'bs-x', idempotencyKey: '' },
        { dispatchAt: DISPATCH_AT },
      ),
    /^Error: bot-join-invalid-request$/,
  );
  assert.equal(repo.loadJoinCalls, 0);
});

test('a null job or non-string dispatch instant throws bot-join-invalid-request', async () => {
  const { service, repo } = buildFixture();
  await assert.rejects(
    () => service.dispatchFromDelivery(null, { dispatchAt: DISPATCH_AT }),
    /bot-join-invalid-request/,
  );
  const { service: s2, repo: r2 } = buildFixture();
  await assert.rejects(
    () =>
      s2.dispatchFromDelivery(
        { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'k' },
        { dispatchAt: undefined },
      ),
    /bot-join-invalid-request/,
  );
  assert.equal(r2.loadJoinCalls, 0);
});

test('a malformed retrigger request throws bot-join-invalid-request', async () => {
  const { service, repo } = buildFixture();
  await assert.rejects(
    () =>
      service.requeueForRetrigger('', {
        dispatchAt: DISPATCH_AT,
        actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
      }),
    /bot-join-invalid-request/,
  );
  await assert.rejects(
    () => service.requeueForRetrigger('m-1', { dispatchAt: DISPATCH_AT }),
    /bot-join-invalid-request/,
  );
  await assert.rejects(
    () => service.requeueForRetrigger('m-1', null),
    /bot-join-invalid-request/,
  );
  assert.equal(repo.loadRequeueCalls, 0);
  assert.equal(repo.createCalls, 0);
});

test('a delivery for a meeting the store cannot see is an internal race, not an outcome', async () => {
  const { service, repo } = buildFixture();
  await assert.rejects(
    () =>
      service.dispatchFromDelivery(
        { meetingId: 'm-gone', botSessionId: 'bs-1', idempotencyKey: 'k' },
        { dispatchAt: DISPATCH_AT },
      ),
    /^Error: bot-join-race-lost$/,
  );
  assertMutatedNothingYet(repo);
});

test('a retrigger for a meeting the store cannot see is an internal race', async () => {
  const { service, repo } = buildFixture();
  await assert.rejects(
    () =>
      service.requeueForRetrigger('m-gone', {
        dispatchAt: DISPATCH_AT,
        actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
      }),
    /^Error: bot-join-race-lost$/,
  );
  assertMutatedNothingYet(repo);
});

test('an off-vocabulary occurrence capture status is row-mapping corruption', async () => {
  const { service, meeting } = buildFixture({});

  meeting.captureStatus = 'PENDING';
  await assert.rejects(
    () =>
      service.dispatchFromDelivery(
        { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
        { dispatchAt: DISPATCH_AT },
      ),
    /bot-join-row-mapping-corrupt/,
  );
});

test('a non-positive scheduleVersion fact is row-mapping corruption', async () => {
  const { service } = buildFixture({ meeting: { scheduleVersion: 0 } });
  await assert.rejects(
    () =>
      service.dispatchFromDelivery(
        { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
        { dispatchAt: DISPATCH_AT },
      ),
    /bot-join-row-mapping-corrupt/,
  );
});

test('an off-vocabulary attempt state on the addressed row is corruption', async () => {
  const { service } = buildFixture({ attempt: { state: 'BOGUS' } });
  await assert.rejects(
    () =>
      service.dispatchFromDelivery(
        { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
        { dispatchAt: DISPATCH_AT },
      ),
    /bot-join-row-mapping-corrupt/,
  );
});

test('the addressed row bound to ANOTHER meeting is corruption', async () => {
  const { service } = buildFixture({ attempt: { meetingId: 'm-other' } });
  await assert.rejects(
    () =>
      service.dispatchFromDelivery(
        { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
        { dispatchAt: DISPATCH_AT },
      ),
    /bot-join-row-mapping-corrupt/,
  );
});

test('non-positive attempt identity facts are corruption (attempt, generation, activationVersion)', async () => {
  for (const prop of [
    'attempt',
    'captureGeneration',
    'scheduleVersionAtActivation',
  ]) {
    const { service } = buildFixture({ attempt: { [prop]: 0 } });
    await assert.rejects(
      () =>
        service.dispatchFromDelivery(
          {
            meetingId: 'm-1',
            botSessionId: 'bs-1',
            idempotencyKey: 'm-1|g1|a1',
          },
          { dispatchAt: DISPATCH_AT },
        ),
      /bot-join-row-mapping-corrupt/,
      `expected corruption for ${prop}`,
    );
  }
});

test('an admission fact outside the ExternalHostAdmissionState vocabulary is corruption', async () => {
  const { service } = buildFixture({ attempt: { admissionState: 'LOBBY' } });
  await assert.rejects(
    () =>
      service.dispatchFromDelivery(
        { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
        { dispatchAt: DISPATCH_AT },
      ),
    /bot-join-row-mapping-corrupt/,
  );
});

test('a CANCELLED occurrence refuses in-policy and never reaches the claim', async () => {
  const { service, repo, fakePort } = buildFixture({
    meeting: { meetingLifecycle: 'CANCELLED' },
  });
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(
    { ...outcome },
    { kind: 'REFUSED', policyReason: 'MEETING_NOT_JOINABLE' },
  );
  assert.equal(fakePort.calls.length, 0);
  assertMutatedNothingYet(repo);
});

test('a superseded/absent delivery row maps to the frozen stale-job gate with zero mutation', async () => {
  const { service, repo, fakePort } = buildFixture();
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-nope', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(
    { ...outcome },
    { kind: 'REFUSED', policyReason: 'STALE_JOB' },
  );
  assert.equal(fakePort.calls.length, 0);
  assertMutatedNothingYet(repo);
});

test('an idempotency key that does not bind the row is a stale delivery', async () => {
  const { service, repo, fakePort } = buildFixture({
    attempt: { idempotencyKey: 'm-1|g1|a-old' },
  });
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(
    { ...outcome },
    { kind: 'REFUSED', policyReason: 'STALE_JOB' },
  );
  assert.equal(fakePort.calls.length, 0);
  assertMutatedNothingYet(repo);
});

test('a rescheduled occurrence (current version moved) refuses the stale attempt (FM-13)', async () => {
  const { service, repo, fakePort } = buildFixture({
    meeting: { scheduleVersion: 4 },
    attempt: { scheduleVersionAtActivation: 3 },
  });
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(
    { ...outcome },
    { kind: 'REFUSED', policyReason: 'STALE_JOB' },
  );
  assert.equal(fakePort.calls.length, 0);
  assertMutatedNothingYet(repo);
});

test('a disabled department refuses in-policy (AJ-06 staleness family)', async () => {
  const { service, repo, fakePort } = buildFixture({
    meeting: { departmentActivationState: 'DISABLED' },
  });
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(
    { ...outcome },
    { kind: 'REFUSED', policyReason: 'DEPARTMENT_NOT_ACTIVE' },
  );
  assert.equal(fakePort.calls.length, 0);
  assertMutatedNothingYet(repo);
});

test('a disabled provider configuration refuses in-policy', async () => {
  const { service, repo, fakePort } = buildFixture({
    meeting: { providerConfigEnabled: false },
  });
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(
    { ...outcome },
    { kind: 'REFUSED', policyReason: 'PROVIDER_NOT_READY' },
  );
  assert.equal(fakePort.calls.length, 0);
  assertMutatedNothingYet(repo);
});

test('unverified capture-policy prerequisites refuse the dispatch (AJ-10)', async () => {
  const { service, repo, fakePort } = buildFixture({
    meeting: { capturePrerequisitesVerified: false },
  });
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(
    { ...outcome },
    { kind: 'REFUSED', policyReason: 'PROVIDER_NOT_READY' },
  );
  assert.equal(fakePort.calls.length, 0);
  assertMutatedNothingYet(repo);
});

test('a not-yet-due delivery refuses in-policy with zero mutation', async () => {
  const { service, repo, fakePort } = buildFixture();
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: '2026-10-27T09:59:00Z' },
  );
  assert.deepEqual(
    { ...outcome },
    { kind: 'REFUSED', policyReason: 'MEETING_NOT_DUE' },
  );
  assert.equal(fakePort.calls.length, 0);
  assertMutatedNothingYet(repo);
});

test('a lost Google Meet URL fact refuses in-policy (shape gate, no crash path)', async () => {
  const { service, repo, fakePort } = buildFixture({
    meeting: { meetUrl: null },
  });
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(
    { ...outcome },
    { kind: 'REFUSED', policyReason: 'DECISION_FACTS_REQUIRED' },
  );
  assert.equal(fakePort.calls.length, 0);
  assertMutatedNothingYet(repo);
});

test('an eligible GENERAL occurrence dispatches with no department fact (AJ-02)', async () => {
  const { service, fakePort } = buildFixture({
    meeting: {
      meetingKind: 'GENERAL',
      departmentActivationState: null,
      departmentId: null,
    },
  });
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.equal(outcome.kind, 'DISPATCHED');
  assert.equal(fakePort.calls.length, 1);
});

test('a redelivery to an already-claimed attempt refuses downstream and never re-dispatches', async () => {
  const { service, repo, fakePort } = buildFixture({
    attempt: { state: 'JOINING', admissionState: null },
  });
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(
    { ...outcome },
    { kind: 'REFUSED_DOWNSTREAM', label: 'NOT_QUEUED' },
  );
  assert.equal(fakePort.calls.length, 0);
  assert.equal(repo.recordCalls, 0);
});

test('a redelivery after a recorded FAILED outcome never re-dispatches (FM-02)', async () => {
  const { service, repo, fakePort } = buildFixture({
    attempt: { state: 'FAILED', admissionState: 'TIMED_OUT' },
  });
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(
    { ...outcome },
    { kind: 'REFUSED_DOWNSTREAM', label: 'NOT_QUEUED' },
  );
  assert.equal(fakePort.calls.length, 0);
  assert.equal(repo.claimCalls, 1);
});

test('a queued row whose occurrence capture left QUEUED refuses the claim', async () => {
  const { service, repo, fakePort, meeting } = buildFixture({});

  meeting.captureStatus = 'NOT_REQUESTED';
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(
    { ...outcome },
    { kind: 'REFUSED_DOWNSTREAM', label: 'NOT_QUEUED' },
  );
  assert.equal(fakePort.calls.length, 0);
  assert.equal(repo.recordCalls, 0);
});

test('a cancel landing between the facts read and the claim is refused at CAS time (RC-11)', async () => {
  const { service, repo, fakePort, meeting } = buildFixture(
    {},
    {
      onBeforeClaim: (job, repoSelf) => {
        meeting.meetingLifecycle = 'CANCELLED';
        meeting.captureStatus = 'CANCELLED';
      },
    },
  );
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(
    { ...outcome },
    { kind: 'REFUSED_DOWNSTREAM', label: 'NOT_QUEUED' },
  );
  assert.equal(fakePort.calls.length, 0);
  assert.equal(meeting.captureStatus, 'CANCELLED');
});

test('a re-activation that replaced the row identity refuses the claim (KEY_MISMATCH)', async () => {
  const { service, repo, fakePort } = buildFixture(
    {
      attempt: { idempotencyKey: 'm-1|g1|a1' },
      meeting: {},
    },
    {
      onBeforeClaim: (job, repoSelf) => {
        const row = repoSelf.sessions.get('bs-1');
        row.idempotencyKey = 'm-1|g1|a-rekeyed';
      },
    },
  );
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(
    { ...outcome },
    { kind: 'REFUSED_DOWNSTREAM', label: 'KEY_MISMATCH' },
  );
  assert.equal(fakePort.calls.length, 0);
  assert.equal(repo.recordCalls, 0);
  assert.equal(repo.sessions.get('bs-1').idempotencyKey, 'm-1|g1|a-rekeyed');
});

test('a scheduleVersion bump landing between the read and the claim refuses at CAS time', async () => {
  const { service, repo, fakePort, meeting } = buildFixture(
    {},
    {
      onBeforeClaim: (job, repoSelf) => {
        meeting.scheduleVersion = 9;
      },
    },
  );
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(
    { ...outcome },
    { kind: 'REFUSED_DOWNSTREAM', label: 'STALE_VERSION' },
  );
  assert.equal(fakePort.calls.length, 0);
  assert.equal(meeting.scheduleVersion, 9);
  assert.equal(repo.sessions.get('bs-1').state, 'QUEUED');
});

test('two concurrent deliveries of the same attempt: exactly one dispatches', async () => {
  const { service, repo, fakePort } = buildFixture({
    portOutcomes: ['JOINING', 'JOINING'],
  });
  const job = {
    meetingId: 'm-1',
    botSessionId: 'bs-1',
    idempotencyKey: 'm-1|g1|a1',
  };
  const [first, second] = await Promise.all([
    service.dispatchFromDelivery(job, { dispatchAt: DISPATCH_AT }),
    service.dispatchFromDelivery(job, { dispatchAt: DISPATCH_AT }),
  ]);
  const kinds = [first.kind, second.kind].sort();
  assert.deepEqual(kinds, ['DISPATCHED', 'REFUSED_DOWNSTREAM']);
  assert.equal(
    fakePort.calls.length,
    1,
    'only the claim-CAS winner reaches the port',
  );
  assert.equal(repo.sessions.get('bs-1').state, 'JOINING');
  assert.equal(repo.meetings.get('m-1').captureStatus, 'JOINING');
});

test('concurrent retrigger requests create exactly ONE new attempt', async () => {
  const { service, repo } = buildFixture({
    attempt: { state: 'FAILED', admissionState: 'DENIED' },
  });
  const [first, second] = await Promise.all([
    service.requeueForRetrigger('m-1', {
      dispatchAt: DISPATCH_AT,
      actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
    }),
    service.requeueForRetrigger('m-1', {
      dispatchAt: DISPATCH_AT,
      actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
    }),
  ]);
  assert.equal(first.kind, 'REQUEUED');
  assert.equal(second.kind, 'REFUSED_DOWNSTREAM');
  assert.equal(second.label, 'NO_TERMINAL_CAPTURE');
  const queued = [...repo.sessions.values()].filter(
    (row) => row.state === 'QUEUED',
  );
  assert.equal(queued.length, 1);
  assert.equal(repo.meetings.get('m-1').captureStatus, 'QUEUED');
});

test('a racing retrigger while the attempt is JOINING is refused (no duplicate bot)', async () => {
  const { service, repo } = buildFixture({
    portOutcomes: ['JOINING', 'JOINING'],
  });
  const job = {
    meetingId: 'm-1',
    botSessionId: 'bs-1',
    idempotencyKey: 'm-1|g1|a1',
  };
  const [dispatchOutcome, requeueOutcome] = await Promise.all([
    service.dispatchFromDelivery(job, { dispatchAt: DISPATCH_AT }),
    service.requeueForRetrigger('m-1', {
      dispatchAt: DISPATCH_AT,
      actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
    }),
  ]);
  assert.equal(dispatchOutcome.kind, 'DISPATCHED');

  assert.equal(requeueOutcome.kind, 'REFUSED_DOWNSTREAM');
  assert.equal(requeueOutcome.label, 'NO_TERMINAL_CAPTURE');
  assert.equal(repo.createCalls, 1);
  assert.equal([...repo.sessions.values()].length, 1);
});

test('a JOINING observation keeps the attempt JOINING with no admission claim', async () => {
  const { service, fakePort } = buildFixture({ portOutcomes: ['JOINING'] });
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(outcome, {
    kind: 'DISPATCHED',
    portObservation: 'JOINING',
    session: { id: 'bs-1', state: 'JOINING', admissionState: null },
  });
});

test('WAITING_FOR_HOST is recorded as observational admission, attempt stays JOINING', async () => {
  const { service, fakePort } = buildFixture({
    portOutcomes: ['WAITING_FOR_HOST'],
  });
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(outcome, {
    kind: 'DISPATCHED',
    portObservation: 'WAITING_FOR_HOST',
    session: {
      id: 'bs-1',
      state: 'JOINING',
      admissionState: 'WAITING_FOR_HOST',
    },
  });
});

test('ADMITTED is recorded as observational admission, attempt stays JOINING', async () => {
  const { service } = buildFixture({ portOutcomes: ['ADMITTED'] });
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(outcome, {
    kind: 'DISPATCHED',
    portObservation: 'ADMITTED',
    session: { id: 'bs-1', state: 'JOINING', admissionState: 'ADMITTED' },
  });
});

test('DENIED fails the attempt (capture FAILED, admission preserved; AJ-07, FM-09)', async () => {
  const { service, repo, fakePort } = buildFixture({
    portOutcomes: ['DENIED'],
  });
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(outcome, {
    kind: 'DISPATCHED',
    portObservation: 'DENIED',
    session: { id: 'bs-1', state: 'FAILED', admissionState: 'DENIED' },
  });
  assert.equal(repo.meetings.get('m-1').captureStatus, 'FAILED');
  assert.equal(
    fakePort.calls.length,
    1,
    'no invented retry follows a denied attempt',
  );
});

test('TIMED_OUT fails the attempt (01 line 39) with the admission observation kept', async () => {
  const { service, repo } = buildFixture({ portOutcomes: ['TIMED_OUT'] });
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(outcome, {
    kind: 'DISPATCHED',
    portObservation: 'TIMED_OUT',
    session: { id: 'bs-1', state: 'FAILED', admissionState: 'TIMED_OUT' },
  });
  assert.equal(repo.meetings.get('m-1').captureStatus, 'FAILED');
});

test('PROVIDER_UNAVAILABLE fails the attempt with NO fabricated admission fact', async () => {
  const { service, repo } = buildFixture({
    portOutcomes: ['PROVIDER_UNAVAILABLE'],
  });
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(outcome, {
    kind: 'DISPATCHED',
    portObservation: 'PROVIDER_UNAVAILABLE',
    session: { id: 'bs-1', state: 'FAILED', admissionState: null },
  });
  assert.equal(repo.meetings.get('m-1').captureStatus, 'FAILED');
  assert.equal(repo.sessions.get('bs-1').admissionState, null);
});

test('an out-of-union provider result is a port VIOLATION, not an outcome; nothing else moves', async () => {
  const { service, repo } = buildFixture({ portOutcomes: ['CAPTURING'] });
  await assert.rejects(
    () =>
      service.dispatchFromDelivery(
        { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
        { dispatchAt: DISPATCH_AT },
      ),
    /^Error: bot-join-provider-port-violation$/,
  );

  assert.equal(repo.sessions.get('bs-1').state, 'JOINING');
  assert.equal(repo.meetings.get('m-1').captureStatus, 'JOINING');
  assert.equal(repo.recordCalls, 0);
});

test('an empty provider result is a port violation too (never remapped)', async () => {
  const { service } = buildFixture({ portOutcomes: [''] });
  await assert.rejects(
    () =>
      service.dispatchFromDelivery(
        { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
        { dispatchAt: DISPATCH_AT },
      ),
    /bot-join-provider-port-violation/,
  );
});

test('a vanished attempt row between dispatch and record preserves the denial verbatim', async () => {
  const { service, repo } = buildFixture(
    { portOutcomes: ['DENIED'] },
    {
      onBeforeRecord: (job, repoSelf) => {
        repoSelf.sessions.delete('bs-1');
      },
    },
  );
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(
    { ...outcome },
    {
      kind: 'OUTCOME_RECORD_REFUSED',
      portObservation: 'DENIED',
      label: 'GONE',
      currentState: null,
    },
  );
});

test('a cancel landing between dispatch and record refuses the write and reports the current state', async () => {
  const { service, repo, meeting } = buildFixture(
    { portOutcomes: ['WAITING_FOR_HOST'] },
    {
      onBeforeRecord: (job, repoSelf) => {
        meeting.meetingLifecycle = 'CANCELLED';
        meeting.captureStatus = 'CANCELLED';
        repoSelf.sessions.get('bs-1').state = 'INTERRUPTED';
      },
    },
  );
  const outcome = await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g1|a1' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.deepEqual(
    { ...outcome },
    {
      kind: 'OUTCOME_RECORD_REFUSED',
      portObservation: 'WAITING_FOR_HOST',
      label: 'NOT_JOINING',
      currentState: 'INTERRUPTED',
    },
  );
  assert.equal(repo.meetings.get('m-1').captureStatus, 'CANCELLED');
});

test('the dispatch payload carries EXACTLY the durable identity facts and nothing else', async () => {
  const { service, fakePort } = buildFixture({
    attempt: { attempt: 2, generation: 4, idempotencyKey: 'm-1|g4|a2' },
  });
  await service.dispatchFromDelivery(
    { meetingId: 'm-1', botSessionId: 'bs-1', idempotencyKey: 'm-1|g4|a2' },
    { dispatchAt: DISPATCH_AT },
  );
  assert.equal(fakePort.calls.length, 1);
  assert.deepEqual(Object.keys(fakePort.calls[0]), [
    'meetingId',
    'botSessionId',
    'idempotencyKey',
    'attempt',
    'joinUrl',
  ]);
  assert.deepEqual(fakePort.calls[0], {
    meetingId: 'm-1',
    botSessionId: 'bs-1',
    idempotencyKey: 'm-1|g4|a2',
    attempt: 2,
    joinUrl: MEET_URL,
  });
});

test('missing actor is rejected before any store read', async () => {
  const { service, repo } = buildFixture({
    attempt: { state: 'FAILED', admissionState: 'DENIED' },
  });
  await assert.rejects(
    service.requeueForRetrigger('m-1', {
      dispatchAt: DISPATCH_AT,
      callerAuthorizedForRetrigger: false,
    }),
    /bot-join-invalid-request/,
  );
  assert.equal(repo.loadRequeueCalls, 0);
  assert.equal(repo.createCalls, 0);
});

test('a FAILED capture can be retriggered into a fresh QUEUED attempt (new identity, old row intact)', async () => {
  const { service, repo, meeting, row } = buildFixture({
    attempt: { state: 'FAILED', admissionState: 'DENIED' },
  });
  const outcome = await service.requeueForRetrigger('m-1', {
    dispatchAt: DISPATCH_AT,
    actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
  });
  assert.equal(outcome.kind, 'REQUEUED');
  assert.equal(outcome.session.state, 'QUEUED');
  assert.equal(outcome.session.attempt, 2);
  assert.ok(
    outcome.session.idempotencyKey === 'm-1|g1|a2',
    'fresh key derivation',
  );
  assert.ok(outcome.session.idempotencyKey !== row.idempotencyKey);
  assert.equal(meeting.captureStatus, 'QUEUED');

  assert.equal(row.state, 'FAILED');
  assert.equal(row.admissionState, 'DENIED');
  assert.equal(repo.meetings.get('m-1').captureStatus, 'QUEUED');
});

test('an INTERRUPTED capture is retriggerable too (01 line 42)', async () => {
  const { service, repo, meeting } = buildFixture({
    attempt: { state: 'INTERRUPTED' },
  });
  const outcome = await service.requeueForRetrigger('m-1', {
    dispatchAt: DISPATCH_AT,
    actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
  });
  assert.equal(outcome.kind, 'REQUEUED');
  assert.equal(meeting.captureStatus, 'QUEUED');
});

test('a capture that never reached a terminal state is not retriggerable', async () => {
  for (const captureStatus of [
    'NOT_REQUESTED',
    'QUEUED',
    'JOINING',
    'CAPTURING',
    'COMPLETED',
  ]) {
    const { service } = buildFixture({ attempt: { state: captureStatus } });
    const outcome = await service.requeueForRetrigger('m-1', {
      dispatchAt: DISPATCH_AT,
      actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
    });
    assert.deepEqual(
      { ...outcome },
      {
        kind: 'REFUSED_DOWNSTREAM',
        label: 'NO_TERMINAL_CAPTURE',
      },
    );
  }
});

test('another live attempt already active blocks the retrigger (no duplicate simultaneous bot)', async () => {
  const { service, repo, meeting, row } = buildFixture({
    attempt: { state: 'FAILED', admissionState: 'DENIED' },
  });

  plantQueuedAttempt(repo, meeting, {
    attempt: 3,
    generation: 1,
    idempotencyKey: 'm-1|g1|a3',
    keepCapture: true,
  });
  const outcome = await service.requeueForRetrigger('m-1', {
    dispatchAt: DISPATCH_AT,
    actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
  });
  assert.deepEqual(
    { ...outcome },
    {
      kind: 'REFUSED_DOWNSTREAM',
      label: 'ACTIVE_ATTEMPT_EXISTS',
    },
  );
  assert.equal(row.state, 'FAILED');
  assert.equal(meeting.captureStatus, 'FAILED');
  assert.equal(repo.createCalls, 1);
});

test('a retrigger of a no-longer-eligible meeting refuses in-policy (meeting ended)', async () => {
  const { service, repo } = buildFixture({
    meeting: { meetingLifecycle: 'ENDED' },
    attempt: { state: 'FAILED', admissionState: 'DENIED' },
  });
  const outcome = await service.requeueForRetrigger('m-1', {
    dispatchAt: DISPATCH_AT,
    actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
  });
  assert.deepEqual(
    { ...outcome },
    {
      kind: 'REFUSED',
      policyReason: 'MEETING_NOT_JOINABLE',
    },
  );
  assert.equal(repo.createCalls, 0);
});

test('a retrigger of a meeting whose department was disabled mid-run refuses in-policy', async () => {
  const { service, repo } = buildFixture({
    meeting: { departmentActivationState: 'DISABLED' },
    attempt: { state: 'FAILED', admissionState: 'DENIED' },
  });
  const outcome = await service.requeueForRetrigger('m-1', {
    dispatchAt: DISPATCH_AT,
    actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
  });
  assert.deepEqual(
    { ...outcome },
    {
      kind: 'REFUSED',
      policyReason: 'DEPARTMENT_NOT_ACTIVE',
    },
  );
  assert.equal(repo.createCalls, 0);
});

test('the retriggered attempt joins the full second dispatch cycle (composition)', async () => {
  const { service, repo, meeting } = buildFixture({
    attempt: { state: 'FAILED', admissionState: 'DENIED' },
  });
  const requeue = await service.requeueForRetrigger('m-1', {
    dispatchAt: DISPATCH_AT,
    actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
  });
  assert.equal(requeue.kind, 'REQUEUED');
  const fakePort = new FakeBotProviderPort(['WAITING_FOR_HOST']);
  const secondService = new BotJoinDispatchService(
    repo,
    fakePort,
    new BotJoinEligibilityPolicy(),
  );
  const outcome = await secondService.dispatchFromDelivery(
    jobFor(repo.sessions.get(requeue.session.id)),
    { dispatchAt: '2026-10-27T11:05:00Z' },
  );
  assert.deepEqual(outcome, {
    kind: 'DISPATCHED',
    portObservation: 'WAITING_FOR_HOST',
    session: {
      id: requeue.session.id,
      state: 'JOINING',
      admissionState: 'WAITING_FOR_HOST',
    },
  });
  assert.equal(fakePort.calls.length, 1);
  assert.equal(repo.meetings.get('m-1').captureStatus, 'JOINING');
});

test('a session row returned with a mismatched session id is corruption', async () => {
  const { service, job, repo } = buildFixture();
  const row = repo.sessions.get(job.botSessionId);
  row.id = 'bs-other';

  await assert.rejects(
    () => service.dispatchFromDelivery(job, { dispatchAt: DISPATCH_AT }),
    /^Error: bot-join-row-mapping-corrupt$/,
  );
});

test('a session row with blank or non-string idempotencyKey is corruption', async () => {
  const { service, job, row } = buildFixture();
  row.idempotencyKey = '   ';
  await assert.rejects(
    () => service.dispatchFromDelivery(job, { dispatchAt: DISPATCH_AT }),
    /^Error: bot-join-row-mapping-corrupt$/,
  );
});

test('an occurrence fact with empty meetingId is corruption', async () => {
  const { service, job, meeting } = buildFixture();
  meeting.meetingId = '';
  await assert.rejects(
    () => service.dispatchFromDelivery(job, { dispatchAt: DISPATCH_AT }),
    /^Error: bot-join-row-mapping-corrupt$/,
  );
});

test('a claim outcome with state not JOINING is corruption', async () => {
  const { service, job, repo } = buildFixture();

  const origClaim = repo.claimJoining.bind(repo);
  repo.claimJoining = async (j) => {
    const res = await origClaim(j);
    return { ok: true, session: { ...res.session, state: 'QUEUED' } };
  };
  await assert.rejects(
    () => service.dispatchFromDelivery(job, { dispatchAt: DISPATCH_AT }),
    /^Error: bot-join-row-mapping-corrupt$/,
  );
});

test('a retrigger outcome with state not QUEUED is corruption', async () => {
  const { service, repo } = buildFixture({
    attempt: { state: 'FAILED', admissionState: 'DENIED' },
  });
  const origCreate = repo.createRetriggerAttempt.bind(repo);
  repo.createRetriggerAttempt = async (mid, cmd) => {
    const res = await origCreate(mid, cmd);
    return { ok: true, session: { ...res.session, state: 'JOINING' } };
  };
  await assert.rejects(
    () =>
      service.requeueForRetrigger('m-1', {
        dispatchAt: DISPATCH_AT,
        actor: { userId: 'synthetic-owner', systemRole: 'OWNER' },
      }),
    /^Error: bot-join-row-mapping-corrupt$/,
  );
});

test('scoped actor retrigger: SystemRole OWNER is authorized', async () => {
  const { service, meeting } = buildFixture({
    attempt: { state: 'FAILED', admissionState: 'DENIED' },
  });
  const outcome = await service.requeueForRetrigger('m-1', {
    dispatchAt: DISPATCH_AT,
    actor: {
      userId: 'u-owner',
      systemRole: 'OWNER',
    },
  });
  assert.equal(outcome.kind, 'REQUEUED');
  assert.equal(meeting.captureStatus, 'QUEUED');
});

test('scoped actor retrigger: SystemRole MANAGER is authorized', async () => {
  const { service, meeting } = buildFixture({
    attempt: { state: 'FAILED', admissionState: 'DENIED' },
  });
  const outcome = await service.requeueForRetrigger('m-1', {
    dispatchAt: DISPATCH_AT,
    actor: {
      userId: 'u-mgr',
      systemRole: 'MANAGER',
    },
  });
  assert.equal(outcome.kind, 'REQUEUED');
  assert.equal(meeting.captureStatus, 'QUEUED');
});

test('scoped actor retrigger: MeetingRole MEETING_ADMIN is authorized', async () => {
  const { service, meeting } = buildFixture({
    attempt: { state: 'FAILED', admissionState: 'DENIED' },
  });
  const outcome = await service.requeueForRetrigger('m-1', {
    dispatchAt: DISPATCH_AT,
    actor: {
      userId: 'u-ma',
      systemRole: 'MEMBER',
      meetingRole: 'MEETING_ADMIN',
    },
  });
  assert.equal(outcome.kind, 'REQUEUED');
  assert.equal(meeting.captureStatus, 'QUEUED');
});

test('scoped actor retrigger: DepartmentRole ADMIN of matching department is authorized', async () => {
  const { service, meeting } = buildFixture({
    attempt: { state: 'FAILED', admissionState: 'DENIED' },
  });
  assert.equal(meeting.departmentId, 'dept-1');
  const outcome = await service.requeueForRetrigger('m-1', {
    dispatchAt: DISPATCH_AT,
    actor: {
      userId: 'u-da',
      systemRole: 'MEMBER',
      departmentId: 'dept-1',
      departmentRole: 'ADMIN',
    },
  });
  assert.equal(outcome.kind, 'REQUEUED');
  assert.equal(meeting.captureStatus, 'QUEUED');
});

test('scoped actor retrigger: DepartmentRole ADMIN of DIFFERENT department is refused', async () => {
  const { service } = buildFixture({
    attempt: { state: 'FAILED', admissionState: 'DENIED' },
  });
  const outcome = await service.requeueForRetrigger('m-1', {
    dispatchAt: DISPATCH_AT,
    actor: {
      userId: 'u-da-other',
      systemRole: 'MEMBER',
      departmentId: 'dept-other',
      departmentRole: 'ADMIN',
    },
  });
  assert.deepEqual(outcome, {
    kind: 'REFUSED_DOWNSTREAM',
    label: 'UNAUTHORIZED_TRIGGER',
  });
});

test('scoped actor retrigger: DepartmentRole ADMIN cannot retrigger GENERAL meetings', async () => {
  const { service } = buildFixture({
    meeting: {
      meetingKind: 'GENERAL',
      departmentId: null,
      departmentActivationState: null,
    },
    attempt: { state: 'FAILED', admissionState: 'DENIED' },
  });
  const outcome = await service.requeueForRetrigger('m-1', {
    dispatchAt: DISPATCH_AT,
    actor: {
      userId: 'u-da',
      systemRole: 'MEMBER',
      departmentId: 'dept-1',
      departmentRole: 'ADMIN',
    },
  });
  assert.deepEqual(outcome, {
    kind: 'REFUSED_DOWNSTREAM',
    label: 'UNAUTHORIZED_TRIGGER',
  });
});

test('scoped actor retrigger: regular MEMBER is refused', async () => {
  const { service } = buildFixture({
    attempt: { state: 'FAILED', admissionState: 'DENIED' },
  });
  const outcome = await service.requeueForRetrigger('m-1', {
    dispatchAt: DISPATCH_AT,
    actor: {
      userId: 'u-mem',
      systemRole: 'MEMBER',
      departmentId: 'dept-1',
      departmentRole: 'MEMBER',
    },
  });
  assert.deepEqual(outcome, {
    kind: 'REFUSED_DOWNSTREAM',
    label: 'UNAUTHORIZED_TRIGGER',
  });
});

test('scoped actor retrigger: REVIEWER/APPROVER/VIEWER meeting roles are refused', async () => {
  for (const meetingRole of ['REVIEWER', 'APPROVER', 'VIEWER']) {
    const { service } = buildFixture({
      attempt: { state: 'FAILED', admissionState: 'DENIED' },
    });
    const outcome = await service.requeueForRetrigger('m-1', {
      dispatchAt: DISPATCH_AT,
      actor: {
        userId: 'u-role',
        systemRole: 'MEMBER',
        meetingRole,
      },
    });
    assert.deepEqual(outcome, {
      kind: 'REFUSED_DOWNSTREAM',
      label: 'UNAUTHORIZED_TRIGGER',
    });
  }
});

test('scoped actor retrigger: malformed actor shape throws bot-join-invalid-request', async () => {
  const { service } = buildFixture({
    attempt: { state: 'FAILED', admissionState: 'DENIED' },
  });

  await assert.rejects(
    () =>
      service.requeueForRetrigger('m-1', {
        dispatchAt: DISPATCH_AT,
        actor: { userId: '', systemRole: 'OWNER' },
      }),
    /^Error: bot-join-invalid-request$/,
  );

  await assert.rejects(
    () =>
      service.requeueForRetrigger('m-1', {
        dispatchAt: DISPATCH_AT,
        actor: { userId: 'u-1', systemRole: 'SUPERADMIN' },
      }),
    /^Error: bot-join-invalid-request$/,
  );

  await assert.rejects(
    () =>
      service.requeueForRetrigger('m-1', {
        dispatchAt: DISPATCH_AT,
        actor: { userId: 'u-1', systemRole: 'MEMBER', departmentRole: 'LEAD' },
      }),
    /^Error: bot-join-invalid-request$/,
  );

  await assert.rejects(
    () =>
      service.requeueForRetrigger('m-1', {
        dispatchAt: DISPATCH_AT,
        actor: { userId: 'u-1', systemRole: 'MEMBER', meetingRole: 'HOST' },
      }),
    /^Error: bot-join-invalid-request$/,
  );
});

test('retrigger without actor and without callerAuthorizedForRetrigger throws bot-join-invalid-request', async () => {
  const { service } = buildFixture({
    attempt: { state: 'FAILED', admissionState: 'DENIED' },
  });
  await assert.rejects(
    () => service.requeueForRetrigger('m-1', { dispatchAt: DISPATCH_AT }),
    /^Error: bot-join-invalid-request$/,
  );
});
