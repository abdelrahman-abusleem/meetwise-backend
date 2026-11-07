'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  OutboxDispatchService,
} = require('../../src/application/outbox-dispatch.service.ts');
const {
  OutboxDispatchPolicy,
} = require('../../src/domain/outbox-dispatch.policy.ts');

class FakeOutboxRepository {
  constructor() {
    this.claimTokensIssued = 0;
    this.calls = { claim: 0, mark: 0 };
    this.hooks = {};
    this.nextClaim = { claimToken: null, claimedCount: null, rows: null };
    this.attemptsDurable = new Map();
    this.nextMark = { marked: true, existingId: null };
  }

  async claimDueUnpublished(batchLimit, leaseSeconds) {
    this.calls.claim += 1;
    if (this.hooks.onBeforeClaim) {
      await this.hooks.onBeforeClaim(batchLimit, leaseSeconds, this);
    }
    const token =
      this.nextClaim.claimToken ?? `tok-${++this.claimTokensIssued}`;
    const rows = this.nextClaim.rows ?? [];
    for (const rowRecord of rows) {
      this.attemptsDurable.set(rowRecord.id, rowRecord.attempts);
    }
    const claimedCount = this.nextClaim.claimedCount ?? rows.length;
    return {
      claim: { claimToken: token, claimedCount },
      rows: rows.map((r) => ({ ...r })),
    };
  }

  async markDispatched(command) {
    this.calls.mark += 1;
    if (this.hooks.onBeforeMark) {
      await this.hooks.onBeforeMark(command, this);
    }
    return this.nextMark;
  }
}

class FakePublishPort {
  constructor() {
    this.envelopes = [];
    this.hooks = {};
    this.order = [];
  }

  async publish(envelope) {
    if (this.hooks.onBeforePublish) {
      await this.hooks.onBeforePublish(envelope, this);
    }
    this.order.push(envelope.eventId);

    this.envelopes.push(envelope);
  }
}

class ThrowingPublishPort {
  constructor() {
    this.calls = 0;
  }
  async publish() {
    this.calls += 1;
    throw new Error('redis-transport-fault');
  }
}

function row(overrides = {}) {
  return {
    id: 'evt-1',
    aggregateType: 'Meeting',
    aggregateId: 'm-1',
    eventType: 'meeting.scheduled.v1',
    eventVersion: 1,
    aggregateVersion: 7,
    payloadJsonSafe: '{"meetingId":"m-1","scheduleVersion":3}',
    attempts: 1,
    createdAt: '2026-10-27T09:00:00Z',
    claimToken: 'tok-claim-1',
    correlationId: 'corr-1',
    causationId: null,
    ...overrides,
  };
}

const TURN = {
  batchLimit: 10,
  leaseSeconds: 30,
  dispatchedAt: '2026-10-27T09:01:00Z',
};

test('creation aggregate version zero is published unchanged', async () => {
  const { port, service } = buildHarness({
    rows: [row({ aggregateVersion: 0 })],
  });
  await service.dispatchDueTurn(TURN);
  assert.equal(port.envelopes.length, 1);
  assert.equal(port.envelopes[0].aggregateVersion, 0);
});
test('negative aggregate version fails closed before publication', async () => {
  const { port, service } = buildHarness({
    rows: [row({ aggregateVersion: -1 })],
  });
  await assert.rejects(service.dispatchDueTurn(TURN));
  assert.equal(port.envelopes.length, 0);
});

function buildHarness({ rows = [], nextMark = null, publisher = null } = {}) {
  const repo = new FakeOutboxRepository();
  if (rows.length !== 0) {
    const token = rows[0].claimToken;
    repo.nextClaim = { claimToken: token, claimedCount: rows.length, rows };
  }
  if (nextMark !== null) {
    repo.nextMark = nextMark;
  }
  const port = publisher ?? new FakePublishPort();
  const service = new OutboxDispatchService(
    repo,
    port,
    new OutboxDispatchPolicy(),
  );
  return { repo, port, service };
}

test('shape gate: non-object turn is refused before any claim or publish', async () => {
  const { repo, port, service } = buildHarness();
  const outcome = await service.dispatchDueTurn(null);
  assert.equal(outcome.kind, 'REFUSED');
  assert.equal(outcome.reason, 'INVALID_REQUEST');
  assert.equal(repo.calls.claim, 0);
  assert.equal(port.envelopes.length, 0);
});

test('shape gate: malformed batchLimit / lease / dispatchedAt fail closed', async () => {
  for (const bad of [
    { ...TURN, batchLimit: 0 },
    { ...TURN, batchLimit: 1.5 },
    { ...TURN, batchLimit: '10' },
    { ...TURN, leaseSeconds: 0 },
    { ...TURN, leaseSeconds: 2.5, batchLimit: 3 },
    { ...TURN, dispatchedAt: '2026-10-27 09:00:00' },
    { ...TURN, dispatchedAt: 1719400000000 },
    { ...TURN, batchLimit: 2, leaseSeconds: 2, dispatchedAt: undefined },
  ]) {
    const { repo, port, service } = buildHarness();
    const outcome = await service.dispatchDueTurn(bad);
    assert.equal(outcome.kind, 'REFUSED');
    assert.equal(outcome.reason, 'DECISION_FACTS_REQUIRED');
    assert.equal(outcome.preventEnumeration, true);
    assert.equal(repo.calls.claim, 0);
    assert.equal(port.envelopes.length, 0);
  }
});

test('zero due rows: IDLE turn with zero publishes and zero marks', async () => {
  const { repo, port, service } = buildHarness();
  const outcome = await service.dispatchDueTurn(TURN);
  assert.equal(outcome.kind, 'IDLE');
  assert.equal(outcome.claimedCount, 0);
  assert.equal(outcome.claimToken, 'tok-1');
  assert.equal(repo.calls.claim, 1);
  assert.equal(port.envelopes.length, 0);
  assert.equal(repo.calls.mark, 0);
});

test('claim facts divergent from returned rows is a LOUD claim defect (no publish)', async () => {
  const { repo, port, service } = buildHarness();
  repo.nextClaim = {
    claimToken: 'tok-x',
    claimedCount: 3,
    rows: [row()],
  };
  await assert.rejects(
    service.dispatchDueTurn(TURN),
    /outbox-dispatch-claim-facts-divergent/,
  );
  assert.equal(port.envelopes.length, 0);
  assert.equal(repo.calls.mark, 0);
});

test('claimed rows publish composed envelopes and mark in claimed order', async () => {
  const rows = [
    row({ id: 'evt-a', correlationId: 'corr-a' }),
    row({
      id: 'evt-b',
      eventType: 'meeting.cancelled.v1',
      causationId: 'cause-b',
      payloadJsonSafe: '{"cancelled":true}',
    }),
  ];
  const { repo, port, service } = buildHarness({ rows });
  const outcome = await service.dispatchDueTurn(TURN);
  assert.equal(outcome.kind, 'DISPATCH_TURN');
  assert.equal(outcome.claimToken, 'tok-claim-1');
  assert.equal(outcome.claimedCount, 2);
  assert.equal(outcome.dispatched, 2);
  assert.equal(outcome.markRefused, 0);
  assert.equal(outcome.publishFailed, 0);
  assert.deepEqual(port.order, ['evt-a', 'evt-b']);
  assert.deepEqual(
    outcome.rows.map((r) => r.kind),
    ['DISPATCHED', 'DISPATCHED'],
  );
  assert.equal(repo.calls.mark, 2);
  assert.deepEqual(
    outcome.rows.map((r) => r.eventId),
    ['evt-a', 'evt-b'],
  );
});

test('envelope is composed EXACTLY from durable row facts (nothing synthesized)', async () => {
  const rows = [
    row({
      id: 'evt-a',
      eventType: 'meeting.scheduled.v1',
      eventVersion: 2,
      aggregateVersion: 7,
      createdAt: '2026-10-27T09:00:00Z',
      correlationId: 'corr-a',
      causationId: null,
      payloadJsonSafe: '{"meetingId":"m-1","scheduleVersion":3}',
    }),
  ];
  const { port, service } = buildHarness({ rows });
  await service.dispatchDueTurn(TURN);
  const env = port.envelopes[0];
  assert.equal(env.eventId, 'evt-a');
  assert.equal(env.type, 'meeting.scheduled.v1');
  assert.equal(env.version, 2);
  assert.equal(env.aggregateType, 'Meeting');
  assert.equal(env.aggregateId, 'm-1');
  assert.equal(env.aggregateVersion, 7);
  assert.equal(env.occurredAt, '2026-10-27T09:00:00Z');
  assert.equal(
    env.correlationId,
    'corr-a',
    'stored correlation carried verbatim',
  );
  assert.equal(
    env.causationId,
    null,
    'missing causation stays null, never fabricated',
  );
  assert.deepEqual(env.payload, { meetingId: 'm-1', scheduleVersion: 3 });
  assert.ok(Object.isFrozen(env), 'envelope is frozen');
});

test('mark command after publish carries id + claim token + dispatchedAt verbatim', async () => {
  const seen = [];
  const { repo, port, service } = buildHarness({ rows: [row()] });
  repo.hooks.onBeforeMark = async (command) => {
    seen.push(command);

    assert.equal(port.envelopes.length, 1);
  };
  await service.dispatchDueTurn(TURN);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    id: 'evt-1',
    claimToken: 'tok-claim-1',
    dispatchedAt: '2026-10-27T09:01:00Z',
  });
});

test('transport fault (FM-03): PUBLISH_FAILED, NO mark, batch continues honestly', async () => {
  const thrower = new ThrowingPublishPort();
  const rows = [
    row({ id: 'evt-a' }),
    row({ id: 'evt-b', payloadJsonSafe: '{"b":2}' }),
  ];
  const { repo, port, service } = buildHarness({ rows, publisher: thrower });
  const outcome = await service.dispatchDueTurn(TURN);
  assert.equal(outcome.kind, 'DISPATCH_TURN');
  assert.equal(outcome.publishFailed, 2);
  assert.equal(outcome.dispatched, 0);
  assert.equal(outcome.markRefused, 0);
  assert.equal(repo.calls.mark, 0, 'unproven enqueue is NEVER marked');
  assert.equal(thrower.calls, 2, 'each row still attempted (batch continues)');
  assert.deepEqual(
    outcome.rows.map((r) => r.kind),
    ['PUBLISH_FAILED', 'PUBLISH_FAILED'],
  );
});

test('publish resolved + mark refused (FM-02): honest MARK_REFUSED, never fabricated', async () => {
  const rows = [
    row({ id: 'evt-a' }),
    row({ id: 'evt-b', payloadJsonSafe: '{"b":2}' }),
  ];
  const { repo, port, service } = buildHarness({
    rows,
    nextMark: { marked: false, existingId: 'evt-a' },
  });
  const outcome = await service.dispatchDueTurn(TURN);
  assert.equal(outcome.kind, 'DISPATCH_TURN');
  assert.equal(outcome.markRefused, 2);
  assert.equal(outcome.dispatched, 0);
  assert.equal(
    port.envelopes.length,
    2,
    'refused rows WERE published (dedupe downstream)',
  );
  assert.equal(repo.calls.mark, 2);
  assert.deepEqual(
    outcome.rows.map((r) => r.kind),
    ['MARK_REFUSED', 'MARK_REFUSED'],
  );
});

test('corrupt durable payload is a LOUD defect before publish (no mark)', async () => {
  const rows = [
    row({ id: 'evt-ok', payloadJsonSafe: '{"good":true}' }),
    row({ id: 'evt-bad', payloadJsonSafe: 'not-json' }),
    row({ id: 'evt-tail', payloadJsonSafe: '{"t":1}' }),
  ];
  const { repo, port, service } = buildHarness({ rows });
  await assert.rejects(
    service.dispatchDueTurn(TURN),
    /outbox-dispatch-payload-corrupt/,
  );

  assert.deepEqual(port.order, ['evt-ok']);
  assert.equal(repo.calls.mark, 1);
});

test('array-shaped and non-object durable payloads are corrupt defects too', async () => {
  for (const payloadJson of ['[1,2]', 'null', '"text"', '3']) {
    const { port, service } = buildHarness({
      rows: [row({ payloadJsonSafe: payloadJson })],
    });
    await assert.rejects(
      service.dispatchDueTurn(TURN),
      /outbox-dispatch-payload-corrupt/,
    );
    assert.equal(port.envelopes.length, 0);
  }
});

test('contract-violating claimed row (attempts shape) is a loud defect, no publish', async () => {
  const { port, service } = buildHarness({
    rows: [row({ attempts: 0 })],
  });
  await assert.rejects(
    service.dispatchDueTurn(TURN),
    /outbox-dispatch-row-contract-violation/,
  );
  assert.equal(port.envelopes.length, 0);
});

test('contract-violating claimed row (missing claim token) is a loud claim-identity defect', async () => {
  const broken = row();
  delete broken.claimToken;
  const { port, service, repo } = buildHarness({ rows: [broken] });
  await assert.rejects(
    service.dispatchDueTurn(TURN),
    /outbox-dispatch-claim-facts-divergent/,
  );
  assert.equal(port.envelopes.length, 0);
  assert.equal(repo.calls.mark, 0);
});

test('contract-violating claimed row (malformed createdAt instant) is a loud defect, no publish', async () => {
  const { port, service, repo } = buildHarness({
    rows: [row({ createdAt: '2026-10-27 09:00:00' })],
  });
  await assert.rejects(
    service.dispatchDueTurn(TURN),
    /outbox-dispatch-row-contract-violation/,
  );
  assert.equal(port.envelopes.length, 0);
  assert.equal(repo.calls.mark, 0);
});

test('contract-violating claimed row (undefined correlation/causation id) is a loud defect, no publish', async () => {
  for (const broken of [
    row({ correlationId: undefined }),
    row({ causationId: undefined }),
  ]) {
    const { port, service, repo } = buildHarness({ rows: [broken] });
    await assert.rejects(
      service.dispatchDueTurn(TURN),
      /outbox-dispatch-row-contract-violation/,
    );
    assert.equal(port.envelopes.length, 0);
    assert.equal(repo.calls.mark, 0);
  }
});

test('turn outcomes are frozen with whitelisted key sets', async () => {
  const rows = [
    row({ id: 'evt-a' }),
    row({ id: 'evt-b', payloadJsonSafe: '{"b":2}' }),
  ];
  const { service } = buildHarness({
    rows,
    nextMark: { marked: false, existingId: 'evt-b' },
  });
  const refused = await service.dispatchDueTurn(null);
  assert.ok(Object.isFrozen(refused));
  const outcome = await service.dispatchDueTurn(TURN);
  assert.ok(Object.isFrozen(outcome));
  for (const rowOutcome of outcome.rows) {
    assert.ok(Object.isFrozen(rowOutcome));
    assert.ok(
      ['DISPATCHED', 'MARK_REFUSED', 'PUBLISH_FAILED'].includes(
        rowOutcome.kind,
      ),
    );
    assert.deepEqual(Object.keys(rowOutcome).sort(), ['eventId', 'kind']);
  }
  assert.deepEqual(Object.keys(outcome).sort(), [
    'claimToken',
    'claimedCount',
    'dispatched',
    'kind',
    'markRefused',
    'publishFailed',
    'rows',
  ]);
});

test('outcomes carry NO computed delay/appointment fields (queue-plane config duty)', async () => {
  const { service } = buildHarness({ rows: [row()] });
  const outcome = await service.dispatchDueTurn(TURN);
  const flat = JSON.stringify(outcome);
  assert.ok(!flat.includes('"delay"'));
  assert.ok(!flat.includes('"nextDispatchAt"'));
});

test('dispatcher lane writes NO InboxReceipt (worker-plane duty stays outside)', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const contractSrc = fs.readFileSync(
    path.join(__dirname, '../../src/application/outbox-dispatch.repository.ts'),
    'utf8',
  );
  assert.ok(!contractSrc.includes('writeInboxOutcome'));
  assert.ok(!contractSrc.includes('findInboxOutcome'));
  const serviceSrc = fs.readFileSync(
    path.join(__dirname, '../../src/application/outbox-dispatch.service.ts'),
    'utf8',
  );
  assert.ok(!serviceSrc.includes('writeInboxOutcome'));
});

test('claim receives BOTH operator facts verbatim: batchLimit AND leaseSeconds', async () => {
  const seen = [];
  const { repo, service } = buildHarness({ rows: [row()] });
  repo.hooks.onBeforeClaim = async (batchLimit, leaseSeconds) => {
    seen.push({ batchLimit, leaseSeconds });
  };
  await service.dispatchDueTurn(TURN);
  assert.deepEqual(seen, [
    { batchLimit: TURN.batchLimit, leaseSeconds: TURN.leaseSeconds },
  ]);
});

test('envelope carries EXACTLY the ten canonical envelope keys (no extra facts leak)', async () => {
  const { port, service } = buildHarness({ rows: [row()] });
  await service.dispatchDueTurn(TURN);
  const env = port.envelopes[0];
  assert.deepEqual(
    Object.keys(env).sort(),
    [
      'aggregateId',
      'aggregateType',
      'aggregateVersion',
      'causationId',
      'correlationId',
      'eventId',
      'occurredAt',
      'payload',
      'type',
      'version',
    ],
    'no dispatch/lease/row field may leak into the job',
  );
});

test('mixed per-row honesty: transport fault on row A, full mark on row B', async () => {
  const rows = [
    row({ id: 'evt-a' }),
    row({ id: 'evt-b', payloadJsonSafe: '{"b":2}' }),
  ];
  const failer = new FakePublishPort();
  failer.hooks.onBeforePublish = async (envelope) => {
    if (envelope.eventId === 'evt-a') throw new Error('redis-down');
  };
  const { repo, port, service } = buildHarness({ rows, publisher: failer });
  const outcome = await service.dispatchDueTurn(TURN);
  assert.equal(outcome.kind, 'DISPATCH_TURN');
  assert.equal(outcome.publishFailed, 1);
  assert.equal(outcome.dispatched, 1);
  assert.equal(outcome.markRefused, 0);
  assert.equal(repo.calls.mark, 1, 'mark only for the resolved row');
  assert.deepEqual(
    outcome.rows.map((r) => r.kind),
    ['PUBLISH_FAILED', 'DISPATCHED'],
  );

  assert.deepEqual(port.order, ['evt-b']);
});

test('selective CAS refusal: only row A loses the mark, row B lands DISPATCHED', async () => {
  const rows = [
    row({ id: 'evt-a' }),
    row({ id: 'evt-b', payloadJsonSafe: '{"b":2}' }),
  ];
  const { repo, port, service } = buildHarness({ rows });
  repo.hooks.onBeforeMark = async (command) => {
    if (command.id === 'evt-a') {
      repo.nextMark = { marked: false, existingId: 'evt-a' };
      return;
    }
    repo.nextMark = { marked: true, existingId: null };
  };
  const outcome = await service.dispatchDueTurn(TURN);
  assert.equal(outcome.kind, 'DISPATCH_TURN');
  assert.equal(outcome.markRefused, 1);
  assert.equal(outcome.dispatched, 1);
  assert.equal(port.envelopes.length, 2, 'refused row WAS published');
  assert.deepEqual(
    outcome.rows.map((r) => r.kind),
    ['MARK_REFUSED', 'DISPATCHED'],
  );
});

test('adversarial claim facts are refused before any publish (foreign token / over-limit / count zero)', async () => {
  const varied = [
    row({ id: 'evt-a', claimToken: 'tok-a' }),
    row({ id: 'evt-b', payloadJsonSafe: '{"b":2}' }),
  ];
  const mismatch = buildHarness({ rows: varied });
  mismatch.repo.nextClaim = {
    claimToken: 'tok-real',
    claimedCount: 2,
    rows: varied,
  };
  await assert.rejects(
    mismatch.service.dispatchDueTurn(TURN),
    /outbox-dispatch-claim-facts-divergent/,
  );
  assert.equal(mismatch.port.envelopes.length, 0);
  assert.equal(mismatch.repo.calls.mark, 0);

  const overLimit = [
    row({ id: 'evt-a' }),
    row({ id: 'evt-b', payloadJsonSafe: '{"b":2}' }),
    row({ id: 'evt-c', payloadJsonSafe: '{"c":3}' }),
  ];
  const exceeded = buildHarness({ rows: overLimit });
  exceeded.repo.nextClaim = {
    claimToken: 'tok-claim-1',
    claimedCount: 3,
    rows: overLimit,
  };
  await assert.rejects(
    exceeded.service.dispatchDueTurn({ ...TURN, batchLimit: 2 }),
    /outbox-dispatch-claim-facts-divergent/,
  );
  assert.equal(exceeded.port.envelopes.length, 0);

  assert.equal(exceeded.repo.calls.mark, 0);

  const zeroCount = buildHarness({ rows: [row()] });
  zeroCount.repo.nextClaim = {
    claimToken: 'tok-claim-1',
    claimedCount: 0,
    rows: [row()],
  };
  await assert.rejects(
    zeroCount.service.dispatchDueTurn(TURN),
    /outbox-dispatch-claim-facts-divergent/,
  );
  assert.equal(zeroCount.port.envelopes.length, 0);
});
