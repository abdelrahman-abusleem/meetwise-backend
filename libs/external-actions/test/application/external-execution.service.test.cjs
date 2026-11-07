'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  ExternalExecutionService,
} = require('../../src/application/external-execution.service.ts');

function yieldTick() {
  return Promise.resolve();
}

function inMemoryRepository() {
  const rows = new Map();
  const items = new Map();
  const connections = new Map();
  const canonical = new Set();
  const calls = [];
  const attemptDutyLog = [];
  let idCounter = 0;
  const hooks = {
    beforeApprovalRecheck: null,
    beforeClaimStatusRecheck: null,
    beforeSettleRecheck: null,
    beforeResolveStatusRecheck: null,
    beforeWithdrawStatusRecheck: null,
  };

  const STATUSES = new Set([
    'PENDING',
    'DISPATCHING',
    'SUCCEEDED',
    'RETRYABLE_FAILED',
    'PERMANENT_FAILED',
    'UNKNOWN',
    'CANCELLED',
  ]);

  function approveStatus(status) {
    if (!STATUSES.has(status)) {
      throw new Error(
        `execution-request-row-mapping-corrupt (status ${String(status)})`,
      );
    }
    return status;
  }

  function canonicalKey(itemId, connectionId, destination, targetKey) {
    return `${itemId}|${connectionId}|${destination}|${targetKey}`;
  }

  function rowView(row) {
    approveStatus(row.status);
    if (
      typeof row.attemptCount !== 'number' ||
      !Number.isInteger(row.attemptCount) ||
      row.attemptCount < 0
    ) {
      throw new Error(
        `execution-request-row-mapping-corrupt (attemptCount ${String(row.attemptCount)})`,
      );
    }
    return Object.freeze({
      id: row.id,
      status: row.status,
      attemptCount: row.attemptCount,
      operation: row.operation,
      destination: row.destination,
      targetKey: row.targetKey,
      storedExternalId: row.storedExternalId,
      storedExternalUrl: row.storedExternalUrl,
    });
  }

  function freshItem(overrides) {
    return {
      approved: true,
      approvedRevision: 'rev-A',
      meetingKind: 'TECH',
      approvedSnapshotId: 'snap-1',
      payload: { title: 'Approved task summary', routeNote: 'GH repo octo/pm' },
      snapshotUnreadable: false,
      ...overrides,
    };
  }

  function seedItem(itemId, overrides) {
    items.set(itemId, freshItem(overrides));
  }

  function seedExecution(overrides) {
    const id = `exec-${++idCounter}`;
    const row = {
      id,
      status: 'PENDING',
      attemptCount: 0,
      operation: 'CREATE',
      destination: 'jira',
      targetKey: 'PROJ',
      storedExternalId: null,
      storedExternalUrl: null,
      analysisItemId: 'item-1',
      connectionId: 'conn-1',
      approvedSnapshotId: 'snap-1',
      payload: { title: 'Approved task summary', routeNote: 'GH repo octo/pm' },
      ...overrides,
    };
    if (!STATUSES.has(row.status)) {
      throw new Error(
        `execution-request-row-mapping-corrupt (status ${row.status})`,
      );
    }
    rows.set(id, row);
    if (row.operation === 'CREATE') {
      canonical.add(
        canonicalKey(
          row.analysisItemId,
          row.connectionId,
          row.destination,
          row.targetKey,
        ),
      );
    }
    return id;
  }

  function seedConnection(connectionId, active) {
    connections.set(connectionId, { active: active !== false });
  }

  function itemRecordFor(row) {
    return items.get(row.analysisItemId);
  }

  return {
    hooks,
    calls,
    attemptDutyLog,
    rows,
    items,
    connections,
    canonical,
    seedItem,
    seedExecution,
    seedConnection,

    async getExecutionFacts(context) {
      calls.push({ method: 'getExecutionFacts', context });
      await yieldTick();
      const row = rows.get(context.executionId);

      if (!row) {
        return Object.freeze({
          executionExists: false,
          status: null,
          operation: null,
          destination: null,
          targetKey: null,
          storedExternalId: null,
          storedExternalUrl: null,
          attemptCount: null,
        });
      }
      return Object.freeze({
        executionExists: true,
        status: approveStatus(row.status),
        operation: row.operation,
        destination: row.destination,
        targetKey: row.targetKey,
        storedExternalId: row.storedExternalId,
        storedExternalUrl: row.storedExternalUrl,
        attemptCount: row.attemptCount,
      });
    },

    async createExecutionRequest(req) {
      calls.push({ method: 'createExecutionRequest', req });
      await yieldTick();
      const item = items.get(req.analysisItemId);
      if (!item || !item.approved) {
        return {
          created: false,
          refusal: 'APPROVAL_STATE_DIVERGED',
          run: null,
        };
      }

      const snapshotId = item.approvedSnapshotId;
      const payload = item.payload;
      if (item.snapshotUnreadable) {
        return {
          created: false,
          refusal: 'APPROVED_SNAPSHOT_UNAVAILABLE',
          run: null,
        };
      }
      if (hooks.beforeApprovalRecheck) {
        hooks.beforeApprovalRecheck({ item });
      }

      const itemNow = items.get(req.analysisItemId);
      if (!itemNow || !itemNow.approved) {
        return {
          created: false,
          refusal: 'APPROVAL_STATE_DIVERGED',
          run: null,
        };
      }
      if (itemNow.meetingKind === 'GENERAL') {
        return {
          created: false,
          refusal: 'GENERAL_EXECUTION_FORBIDDEN',
          run: null,
        };
      }
      if (
        req.operation === 'LINK_EXISTING' ||
        req.operation === 'KEEP_INTERNAL' ||
        req.operation === 'CREATE_ANOTHER'
      ) {
        return {
          created: false,
          refusal:
            req.operation === 'CREATE_ANOTHER'
              ? 'CREATE_ANOTHER_NOT_IN_V1'
              : 'NON_OUTBOUND_ROUTE_NOT_IN_SLICE',
          run: null,
        };
      }

      if (
        req.operation === 'CREATE' &&
        canonical.has(
          canonicalKey(
            req.analysisItemId,
            req.connectionId,
            req.destination,
            req.targetKey,
          ),
        )
      ) {
        return {
          created: false,
          refusal: 'CANONICAL_CREATE_EXISTS',
          run: null,
        };
      }
      const id = `exec-${++idCounter}`;
      const row = {
        id,
        status: 'PENDING',
        attemptCount: 0,
        operation: req.operation,
        destination: req.destination,
        targetKey: req.targetKey,
        storedExternalId: null,
        storedExternalUrl: null,
        analysisItemId: req.analysisItemId,
        connectionId: req.connectionId,
        approvedSnapshotId: snapshotId,
        payload,
      };
      rows.set(id, row);
      if (req.operation === 'CREATE') {
        canonical.add(
          canonicalKey(
            req.analysisItemId,
            req.connectionId,
            req.destination,
            req.targetKey,
          ),
        );
      }
      return { created: true, refusal: null, run: rowView(row) };
    },

    async claimExecution(context) {
      calls.push({ method: 'claimExecution', context });
      await yieldTick();
      const row = rows.get(context.executionId);
      if (!row) {
        return {
          claimed: false,
          refusal: 'CLAIM_RACE_LOST',
          run: null,
          dispatchPayload: null,
        };
      }
      if (hooks.beforeClaimStatusRecheck) {
        hooks.beforeClaimStatusRecheck({ row });
      }

      if (!rows.has(context.executionId)) {
        return {
          claimed: false,
          refusal: 'CLAIM_RACE_LOST',
          run: null,
          dispatchPayload: null,
        };
      }
      const statusNow = approveStatus(row.status);
      if (statusNow !== 'PENDING' && statusNow !== 'RETRYABLE_FAILED') {
        return {
          claimed: false,
          refusal: 'CLAIM_RACE_LOST',
          run: null,
          dispatchPayload: null,
        };
      }
      const conn = connections.get(row.connectionId);
      if (!conn || conn.active !== true) {
        return {
          claimed: false,
          refusal: 'CONNECTION_UNAVAILABLE',
          run: null,
          dispatchPayload: null,
        };
      }
      const item = itemRecordFor(row);
      if (!item || item.snapshotUnreadable) {
        throw new Error(
          'execution-request-row-mapping-corrupt (claim snapshot integrity unreadable)',
        );
      }
      if (
        row.approvedSnapshotId !== item.approvedSnapshotId ||
        item.snapshotTampered === true
      ) {
        return {
          claimed: false,
          refusal: 'SNAPSHOT_DIVERGED',
          run: null,
          dispatchPayload: null,
        };
      }
      if (item.meetingKind === 'GENERAL') {
        return {
          claimed: false,
          refusal: 'GENERAL_EXECUTION_FORBIDDEN',
          run: null,
          dispatchPayload: null,
        };
      }

      row.status = 'DISPATCHING';
      row.attemptCount += 1;
      row.leaseOwner = `worker-${row.id}`;
      row.leasedUntil = '2099-01-01T00:00:00Z';
      row.fence = Object.freeze({
        attemptId: `attempt-${row.id}-${row.attemptCount}`,
        attemptNumber: row.attemptCount,
        leaseToken: `lease-${row.id}-${row.attemptCount}`,
        leaseExpiresAt: row.leasedUntil,
      });
      return {
        claimed: true,
        refusal: null,
        run: rowView(row),
        fence: row.fence,
        dispatchPayload: Object.freeze({
          approvedSnapshotId: row.approvedSnapshotId,
          payload: item.payload,
        }),
      };
    },

    async settleDispatchOutcome(req) {
      calls.push({ method: 'settleDispatchOutcome', req });
      await yieldTick();
      const row = rows.get(req.executionId);
      if (!row) {
        return { settled: false, refusal: 'SETTLE_RACE_LOST', run: null };
      }
      if (hooks.beforeSettleRecheck) {
        hooks.beforeSettleRecheck({ row, req });
      }

      if (!rows.has(req.executionId)) {
        return { settled: false, refusal: 'SETTLE_RACE_LOST', run: null };
      }
      const statusNow = approveStatus(row.status);
      if (statusNow !== 'DISPATCHING') {
        return { settled: false, refusal: 'SETTLE_RACE_LOST', run: null };
      }
      if (
        JSON.stringify(req.fence) !== JSON.stringify(row.fence) ||
        Date.parse(row.fence.leaseExpiresAt) <= Date.now()
      ) {
        return { settled: false, refusal: 'SETTLE_RACE_LOST', run: null };
      }

      attemptDutyLog.push({
        executionId: req.executionId,
        command: req.command,
        ordinal: 'adapter-managed',
        detail:
          req.command === 'CONFIRM_SUCCESS'
            ? { resultCode: 'PROVIDER_CONFIRMED', externalRef: req.externalRef }
            : req.command === 'MARK_UNKNOWN'
              ? { resultCode: 'UNKNOWN' }
              : { resultCode: req.command, reason: req.reason },
      });
      if (req.command === 'CONFIRM_SUCCESS') {
        if (
          typeof req.externalRef !== 'string' ||
          String(req.externalRef).trim() === ''
        ) {
          throw new Error(
            'execution-request-row-mapping-corrupt (write integrity: CONFIRM_SUCCESS externalRef)',
          );
        }
        row.status = 'SUCCEEDED';
        row.storedExternalId = req.externalRef;
        row.storedExternalUrl =
          typeof req.externalUrl === 'string' ? req.externalUrl : null;
      } else if (req.command === 'RECORD_RETRYABLE_FAILURE') {
        if (
          typeof req.reason !== 'string' ||
          String(req.reason).trim() === ''
        ) {
          throw new Error(
            'execution-request-row-mapping-corrupt (write integrity: RECORD_RETRYABLE_FAILURE reason)',
          );
        }
        row.status = 'RETRYABLE_FAILED';
      } else if (req.command === 'RECORD_PERMANENT_FAILURE') {
        if (
          typeof req.reason !== 'string' ||
          String(req.reason).trim() === ''
        ) {
          throw new Error(
            'execution-request-row-mapping-corrupt (write integrity: RECORD_PERMANENT_FAILURE reason)',
          );
        }
        row.status = 'PERMANENT_FAILED';
      } else if (req.command === 'MARK_UNKNOWN') {
        row.status = 'UNKNOWN';
      } else {
        throw new Error(
          'execution-request-row-mapping-corrupt (write integrity: unknown settle command)',
        );
      }
      return { settled: true, refusal: null, run: rowView(row) };
    },

    async resolveUnknown(req) {
      calls.push({ method: 'resolveUnknown', req });
      await yieldTick();
      const row = rows.get(req.executionId);
      if (!row) {
        return { settled: false, refusal: 'RESOLVE_RACE_LOST', run: null };
      }
      if (hooks.beforeResolveStatusRecheck) {
        hooks.beforeResolveStatusRecheck({ row, req });
      }

      if (!rows.has(req.executionId)) {
        return { settled: false, refusal: 'RESOLVE_RACE_LOST', run: null };
      }
      const statusNow = approveStatus(row.status);
      if (
        statusNow !== 'UNKNOWN' ||
        req.expectedAttemptCount !== row.attemptCount
      ) {
        return { settled: false, refusal: 'RESOLVE_RACE_LOST', run: null };
      }
      attemptDutyLog.push({
        executionId: req.executionId,
        command: req.command,
        ordinal: 'adapter-managed',
        detail:
          req.command === 'RESOLVE_UNKNOWN_FOUND'
            ? { resultCode: 'LINKED_EXISTING', externalRef: req.externalRef }
            : { resultCode: req.command, reason: req.reason },
      });
      if (req.command === 'RESOLVE_UNKNOWN_FOUND') {
        if (
          typeof req.externalRef !== 'string' ||
          String(req.externalRef).trim() === ''
        ) {
          throw new Error(
            'execution-request-row-mapping-corrupt (write integrity: RESOLVE_UNKNOWN_FOUND externalRef)',
          );
        }
        row.status = 'SUCCEEDED';
        row.storedExternalId = req.externalRef;
        row.storedExternalUrl =
          typeof req.externalUrl === 'string' ? req.externalUrl : null;
      } else if (req.command === 'RESOLVE_UNKNOWN_NOT_EXECUTED') {
        if (
          typeof req.reason !== 'string' ||
          String(req.reason).trim() === ''
        ) {
          throw new Error(
            'execution-request-row-mapping-corrupt (write integrity: RESOLVE_UNKNOWN_NOT_EXECUTED reason)',
          );
        }
        row.status = 'RETRYABLE_FAILED';
      } else {
        throw new Error(
          'execution-request-row-mapping-corrupt (write integrity: unknown resolve command)',
        );
      }
      return { settled: true, refusal: null, run: rowView(row) };
    },

    async withdrawExecution(req) {
      calls.push({ method: 'withdrawExecution', req });
      await yieldTick();
      const row = rows.get(req.executionId);
      if (!row) {
        return { settled: false, refusal: 'WITHDRAW_RACE_LOST', run: null };
      }
      if (hooks.beforeWithdrawStatusRecheck) {
        hooks.beforeWithdrawStatusRecheck({ row, req });
      }

      if (!rows.has(req.executionId)) {
        return { settled: false, refusal: 'WITHDRAW_RACE_LOST', run: null };
      }
      const statusNow = approveStatus(row.status);
      if (statusNow !== 'PENDING' && statusNow !== 'RETRYABLE_FAILED') {
        return { settled: false, refusal: 'WITHDRAW_RACE_LOST', run: null };
      }
      attemptDutyLog.push({
        executionId: req.executionId,
        command: 'WITHDRAW_ROUTE',
        ordinal: 'adapter-managed',
        detail: { auditReason: req.reason },
      });
      row.status = 'CANCELLED';
      return { settled: true, refusal: null, run: rowView(row) };
    },
  };
}

function deterministicProvider(outcomeMap) {
  const log = [];
  let throwOnExecute = null;
  let throwOnLookup = null;
  const port = {
    async executeDispatch(instruction) {
      log.push({ method: 'executeDispatch', instruction });
      if (throwOnExecute) {
        throw throwOnExecute;
      }
      const outcome = outcomeMap[instruction.executionId];
      if (outcome === undefined) {
        throw new Error('fake-provider-misconfigured (no execute outcome)');
      }
      if (outcome && outcome.__violation) {
        return outcome.__violation;
      }
      return outcome;
    },
    async lookupExternalByCorrelation(instruction) {
      log.push({ method: 'lookupExternalByCorrelation', instruction });
      if (throwOnLookup) {
        throw throwOnLookup;
      }
      const outcome = outcomeMap[instruction.executionId];
      if (outcome === undefined) {
        throw new Error('fake-provider-misconfigured (no lookup outcome)');
      }
      if (outcome && outcome.__violation) {
        return outcome.__violation;
      }
      return outcome;
    },
  };
  return {
    port,
    log,

    setOutcome(executionId, outcome) {
      outcomeMap[executionId] = outcome;
    },
    throwOnExecute(msg) {
      throwOnExecute = new Error(msg);
    },
    throwOnLookup(msg) {
      throwOnLookup = new Error(msg);
    },
    count(method) {
      return log.filter((entry) => entry.method === method).length;
    },
  };
}

function service(repo) {
  return new ExternalExecutionService(repo);
}

function createRouteInput(overrides) {
  return {
    analysisItemId: 'item-1',
    connectionId: 'conn-1',
    destination: 'jira',
    operation: 'CREATE',
    targetKey: 'PROJ',
    ...overrides,
  };
}

test('A1: a CREATE route of an approved item creates a PENDING row', async () => {
  const repo = inMemoryRepository();
  repo.seedItem('item-1', {});
  repo.seedConnection('conn-1', true);
  const result = await service(repo).requestExecutionRoute(
    createRouteInput({}),
  );
  assert.equal(result.ok, true);
  assert.equal(result.k, 'ROUTE_REQUESTED');
  assert.equal(result.run.status, 'PENDING');
  assert.equal(result.run.operation, 'CREATE');
  assert.equal(result.run.storedExternalId, null);
  assert.equal(result.run.attemptCount, 0);
  assert.equal(result.requestedEventIsApproveTxDuty, true);
  assert.ok(Object.isFrozen(result));
});

test('A2: an UPDATE_EXISTING route creates a PENDING row too', async () => {
  const repo = inMemoryRepository();
  repo.seedItem('item-1', {});
  repo.seedConnection('conn-1', true);
  const result = await service(repo).requestExecutionRoute(
    createRouteInput({ operation: 'UPDATE_EXISTING', targetKey: 'ISSUE-7' }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.run.operation, 'UPDATE_EXISTING');
  assert.equal(result.run.status, 'PENDING');
});

test('A3: LINK_EXISTING takes no outbound execution row', async () => {
  const repo = inMemoryRepository();
  repo.seedItem('item-1', {});
  repo.seedConnection('conn-1', true);
  const result = await service(repo).requestExecutionRoute(
    createRouteInput({ operation: 'LINK_EXISTING' }),
  );
  assert.deepEqual(result, {
    ok: false,
    reason: 'NON_OUTBOUND_ROUTE_NOT_IN_SLICE',
  });
  assert.equal(repo.rows.size, 0);
});

test('A4: KEEP_INTERNAL takes no outbound execution row', async () => {
  const repo = inMemoryRepository();
  repo.seedItem('item-1', {});
  repo.seedConnection('conn-1', true);
  const result = await service(repo).requestExecutionRoute(
    createRouteInput({ operation: 'KEEP_INTERNAL' }),
  );
  assert.equal(result.reason, 'NON_OUTBOUND_ROUTE_NOT_IN_SLICE');
  assert.equal(repo.rows.size, 0);
});

test('A5: CREATE_ANOTHER is explicitly not implemented in v1 (03 §7)', async () => {
  const repo = inMemoryRepository();
  repo.seedItem('item-1', {});
  repo.seedConnection('conn-1', true);
  const result = await service(repo).requestExecutionRoute(
    createRouteInput({ operation: 'CREATE_ANOTHER' }),
  );
  assert.equal(result.reason, 'CREATE_ANOTHER_NOT_IN_V1');
  assert.equal(repo.rows.size, 0);
});

test('A6: a second canonical CREATE for the same target is refused', async () => {
  const repo = inMemoryRepository();
  repo.seedItem('item-1', {});
  repo.seedConnection('conn-1', true);
  const svc = service(repo);
  await svc.requestExecutionRoute(createRouteInput({}));
  const before = Array.from(repo.rows.values()).map((r) => ({ ...r }));
  const second = await svc.requestExecutionRoute(createRouteInput({}));
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'CANONICAL_CREATE_EXISTS');
  const after = Array.from(repo.rows.values()).map((r) => ({ ...r }));
  assert.deepEqual(after, before);
});

test('A7: a same-identity UPDATE_EXISTING route is not canonical-guarded', async () => {
  const repo = inMemoryRepository();
  repo.seedItem('item-1', {});
  repo.seedConnection('conn-1', true);
  const svc = service(repo);
  const first = await svc.requestExecutionRoute(
    createRouteInput({ operation: 'UPDATE_EXISTING', targetKey: 'ISSUE-7' }),
  );
  const second = await svc.requestExecutionRoute(
    createRouteInput({ operation: 'UPDATE_EXISTING', targetKey: 'ISSUE-7' }),
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.run.id, second.run.id);
});

test('A8: an item revoked inside the creation tx refuses APPROVAL_STATE_DIVERGED', async () => {
  const repo = inMemoryRepository();
  repo.seedItem('item-1', {});
  repo.seedConnection('conn-1', true);
  repo.hooks.beforeApprovalRecheck = ({ item }) => {
    item.approved = false;
  };
  const result = await service(repo).requestExecutionRoute(
    createRouteInput({}),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'APPROVAL_STATE_DIVERGED');
  assert.equal(repo.rows.size, 0);
});

test('A9: an unreadable approved snapshot refuses fail closed', async () => {
  const repo = inMemoryRepository();
  repo.seedItem('item-1', { snapshotUnreadable: true });
  repo.seedConnection('conn-1', true);
  const result = await service(repo).requestExecutionRoute(
    createRouteInput({}),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'APPROVED_SNAPSHOT_UNAVAILABLE');
  assert.equal(repo.rows.size, 0);
});

test('A10: a GENERAL-meeting item never creates an execution row (01 line 8)', async () => {
  const repo = inMemoryRepository();
  repo.seedItem('item-1', { meetingKind: 'GENERAL' });
  repo.seedConnection('conn-1', true);
  const result = await service(repo).requestExecutionRoute(
    createRouteInput({}),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'GENERAL_EXECUTION_FORBIDDEN');
  assert.equal(repo.rows.size, 0);
});

test('A11: malformed route queries fail the shape gate', async () => {
  const svc = service(inMemoryRepository());
  assert.equal(
    (await svc.requestExecutionRoute(null)).reason,
    'EXECUTION_FACTS_REQUIRED',
  );
  assert.equal(
    (
      await svc.requestExecutionRoute(
        createRouteInput({ analysisItemId: '   ' }),
      )
    ).reason,
    'EXECUTION_FACTS_REQUIRED',
  );
  assert.equal(
    (
      await svc.requestExecutionRoute(
        createRouteInput({ operation: 'NOT_A_ROUTE' }),
      )
    ).reason,
    'EXECUTION_FACTS_REQUIRED',
  );
});

function dispatchHarness(statusOverrides) {
  const repo = inMemoryRepository();
  repo.seedItem('item-1', {});
  repo.seedConnection('conn-1', true);
  const executionId = repo.seedExecution(
    statusOverrides && statusOverrides.status
      ? { status: statusOverrides.status }
      : {},
  );
  return { repo, executionId, svc: service(repo) };
}

test('B1: a CONFIRMED provider outcome settles SUCCEEDED with the reference', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  const fake = deterministicProvider({
    [executionId]: {
      k: 'CONFIRMED',
      externalId: 'GH-42',
      externalUrl: 'https://gh/42',
    },
  });
  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.ok, true);
  assert.equal(result.k, 'SUCCEEDED');
  assert.equal(result.run.status, 'SUCCEEDED');
  assert.equal(result.run.storedExternalId, 'GH-42');
  assert.equal(result.run.storedExternalUrl, 'https://gh/42');
  assert.equal(result.providerCallMade, true);

  const call = fake.log[0];
  assert.equal(call.method, 'executeDispatch');
  assert.equal(call.instruction.executionId, executionId);
  assert.equal(call.instruction.operation, 'CREATE');
  assert.equal(call.instruction.destination, 'jira');
  assert.equal(call.instruction.targetKey, 'PROJ');
  assert.equal(call.instruction.approvedSnapshotId, 'snap-1');
  assert.deepEqual(call.instruction.approvedPayload, {
    title: 'Approved task summary',
    routeNote: 'GH repo octo/pm',
  });
  assert.ok(Object.isFrozen(result));
});

test('B2: RETRYABLE_NO_EFFECT settles RETRYABLE_FAILED with the reason', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  const fake = deterministicProvider({
    [executionId]: {
      k: 'RETRYABLE_NO_EFFECT',
      reason: 'provider 503 held, no effect',
    },
  });
  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.k, 'RETRYABLE_FAILED');
  assert.equal(result.run.status, 'RETRYABLE_FAILED');
  assert.equal(result.run.attemptCount, 1);
  assert.equal(repo.attemptDutyLog[0].command, 'RECORD_RETRYABLE_FAILURE');
  assert.equal(
    repo.attemptDutyLog[0].detail.reason,
    'provider 503 held, no effect',
  );
});

test('B3: PERMANENT_DENIED settles PERMANENT_FAILED (row 87)', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  const fake = deterministicProvider({
    [executionId]: { k: 'PERMANENT_DENIED', reason: '401 credential invalid' },
  });
  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.k, 'PERMANENT_FAILED');
  assert.equal(result.run.status, 'PERMANENT_FAILED');
});

test('B4: UNKNOWN_EFFECT settles UNKNOWN and hands over to the reconciler', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  const fake = deterministicProvider({
    [executionId]: { k: 'UNKNOWN_EFFECT' },
  });
  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.k, 'UNKNOWN');
  assert.equal(result.run.status, 'UNKNOWN');
  assert.equal(result.unknownEventIsReconcilerDuty, true);
  assert.equal(result.providerCallMade, true);
});

test('B5: a CONFIRMED outcome with a blank reference fails closed to UNKNOWN', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  const fake = deterministicProvider({
    [executionId]: { k: 'CONFIRMED', externalId: '  ' },
  });
  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.k, 'UNKNOWN');
  assert.equal(result.run.status, 'UNKNOWN');
  assert.equal(result.run.storedExternalId, null);
});

test('B6: a retryable outcome with a blank reason fails closed to UNKNOWN', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  const fake = deterministicProvider({
    [executionId]: { k: 'RETRYABLE_NO_EFFECT', reason: '' },
  });
  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.k, 'UNKNOWN');
  assert.equal(repo.attemptDutyLog.length, 1);
  assert.equal(repo.attemptDutyLog[0].command, 'MARK_UNKNOWN');
});

test('B7: a permanent outcome with a blank reason fails closed to UNKNOWN', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  const fake = deterministicProvider({
    [executionId]: { k: 'PERMANENT_DENIED', reason: 42 },
  });
  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.k, 'UNKNOWN');
});

test('B8: the settle tx never mutates the adapter-managed attemptCount', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  repo.rows.get(executionId).attemptCount = 7;
  const fake = deterministicProvider({
    [executionId]: { k: 'CONFIRMED', externalId: 'GH-9' },
  });
  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.k, 'SUCCEEDED');
  assert.equal(result.run.attemptCount, 8);
});

test('B9: a missing/malformed provider port is refused before storage', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  assert.equal(
    (await svc.dispatchExecution({ executionId, provider: null })).reason,
    'PROVIDER_PORT_REQUIRED',
  );
  assert.equal(
    (await svc.dispatchExecution({ executionId, provider: {} })).reason,
    'PROVIDER_PORT_REQUIRED',
  );
  assert.equal(repo.calls.length, 0);
});

test('B10: a missing execution refuses EXECUTION_NOT_FOUND before any claim', async () => {
  const svc = service(inMemoryRepository());
  const fake = deterministicProvider({ 'exec-x': { k: 'UNKNOWN_EFFECT' } });
  const result = await svc.dispatchExecution({
    executionId: 'exec-x',
    provider: fake.port,
  });
  assert.equal(result.reason, 'EXECUTION_NOT_FOUND');
  assert.equal(fake.count('executeDispatch'), 0);
});

test('B11: a redelivered job for a SUCCEEDED row never re-dispatches (row 93)', async () => {
  const { repo, executionId, svc } = dispatchHarness({ status: 'SUCCEEDED' });
  repo.rows.get(executionId).storedExternalId = 'GH-42';
  const fake = deterministicProvider({});
  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'UNAUTHORIZED');
  assert.equal(fake.count('executeDispatch'), 0);
  assert.equal(repo.rows.get(executionId).status, 'SUCCEEDED');
});

test('B12: UNKNOWN is never re-dispatched (MW-034 no blind retry)', async () => {
  const { repo, executionId, svc } = dispatchHarness({ status: 'UNKNOWN' });
  const fake = deterministicProvider({});
  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.reason, 'UNAUTHORIZED');
  assert.equal(fake.count('executeDispatch'), 0);
  assert.equal(repo.rows.get(executionId).status, 'UNKNOWN');
});

test('B13: terminal rows (CANCELLED / PERMANENT_FAILED) never re-claim', async () => {
  for (const status of ['CANCELLED', 'PERMANENT_FAILED']) {
    const { repo, executionId, svc } = dispatchHarness({ status });
    const fake = deterministicProvider({});
    const result = await svc.dispatchExecution({
      executionId,
      provider: fake.port,
    });
    assert.equal(result.reason, 'UNAUTHORIZED');
    assert.equal(fake.count('executeDispatch'), 0);
    assert.equal(repo.rows.get(executionId).status, status);
  }
});

test('B14: concurrent duplicate dispatches produce exactly one provider call', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  const fake = deterministicProvider({
    [executionId]: { k: 'CONFIRMED', externalId: 'GH-77' },
  });
  const [first, second] = await Promise.all([
    svc.dispatchExecution({ executionId, provider: fake.port }),
    svc.dispatchExecution({ executionId, provider: fake.port }),
  ]);
  const suffixes = [first, second].map((r) => (r.ok ? r.k : r.reason)).sort();
  assert.deepEqual(suffixes, ['EXECUTION_STATE_CONFLICT', 'SUCCEEDED']);
  assert.equal(fake.count('executeDispatch'), 1);
  assert.equal(repo.rows.get(executionId).status, 'SUCCEEDED');
});

test('B15: connection turned off in-tx refuses FM-34 with zero mutation', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  repo.hooks.beforeClaimStatusRecheck = () => {
    repo.connections.set('conn-1', { active: false });
  };
  const fake = deterministicProvider({
    [executionId]: { k: 'CONFIRMED', externalId: 'GH-1' },
  });
  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.reason, 'CONNECTION_UNAVAILABLE');
  assert.equal(repo.rows.get(executionId).status, 'PENDING');
  assert.equal(fake.count('executeDispatch'), 0);
});

test('B16: a tampered committed snapshot refuses SNAPSHOT_DIVERGED in-tx', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  repo.hooks.beforeClaimStatusRecheck = () => {
    repo.items.get('item-1').snapshotTampered = true;
  };
  const fake = deterministicProvider({
    [executionId]: { k: 'CONFIRMED', externalId: 'GH-1' },
  });
  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.reason, 'SNAPSHOT_DIVERGED');
  assert.equal(repo.rows.get(executionId).status, 'PENDING');
  assert.equal(fake.count('executeDispatch'), 0);
});

test('B17: GENERAL re-derivation in-tx refuses with zero mutation', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  repo.hooks.beforeClaimStatusRecheck = () => {
    repo.items.get('item-1').meetingKind = 'GENERAL';
  };
  const fake = deterministicProvider({
    [executionId]: { k: 'CONFIRMED', externalId: 'GH-1' },
  });
  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.reason, 'GENERAL_EXECUTION_FORBIDDEN');
  assert.equal(repo.rows.get(executionId).status, 'PENDING');
  assert.equal(fake.count('executeDispatch'), 0);
});

test('B18: a row settled concurrently in-tx loses the settle CAS (no overwrite)', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  repo.hooks.beforeSettleRecheck = () => {
    const row = repo.rows.get(executionId);
    if (row.status === 'DISPATCHING') {
      row.status = 'SUCCEEDED';
      row.storedExternalId = 'GH-FIRST';
    }
  };
  const fake = deterministicProvider({
    [executionId]: { k: 'CONFIRMED', externalId: 'GH-SECOND' },
  });
  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'EXECUTION_STATE_CONFLICT');
  assert.equal(repo.rows.get(executionId).status, 'SUCCEEDED');
  assert.equal(repo.rows.get(executionId).storedExternalId, 'GH-FIRST');
});

test('B19: a provider exception propagates and leaves no invented settle', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  const fake = deterministicProvider({
    [executionId]: { k: 'UNKNOWN_EFFECT' },
  });
  fake.throwOnExecute('network failure mid-flight');
  await assert.rejects(
    () =>
      svc.dispatchExecution({
        executionId,
        provider: fake.port,
      }),
    /network failure mid-flight/,
  );

  assert.equal(repo.rows.get(executionId).status, 'DISPATCHING');
});

test('B20: a malformed provider outcome is a thrown port violation', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  const fake = deterministicProvider({
    [executionId]: { __violation: { k: 'MAGIC_WENT_WELL' } },
  });
  await assert.rejects(
    () => svc.dispatchExecution({ executionId, provider: fake.port }),
    /provider-port-violation/,
  );
  assert.equal(repo.rows.get(executionId).status, 'DISPATCHING');
  assert.equal(
    repo.calls.filter((c) => c.method === 'settleDispatchOutcome').length,
    0,
  );
});

test('C1: UNKNOWN + FOUND resolves SUCCEEDED and links the existing item', async () => {
  const { repo, executionId, svc } = dispatchHarness({ status: 'UNKNOWN' });
  const fake = deterministicProvider({
    [executionId]: {
      k: 'FOUND',
      externalId: 'EXT-1',
      externalUrl: 'https://ext/1',
    },
  });
  const result = await svc.reconcileUnknown({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.ok, true);
  assert.equal(result.k, 'SUCCEEDED');
  assert.equal(result.run.status, 'SUCCEEDED');
  assert.equal(result.run.storedExternalId, 'EXT-1');
  assert.equal(result.providerLookupMade, true);
  const lookup = fake.log[0];
  assert.equal(lookup.method, 'lookupExternalByCorrelation');
  assert.deepEqual(lookup.instruction, {
    executionId,
    operation: 'CREATE',
    destination: 'jira',
    targetKey: 'PROJ',
  });
});

test('C2: UNKNOWN + NOT_FOUND_PROVEN re-enters RETRYABLE_FAILED (row 90 only exit)', async () => {
  const { repo, executionId, svc } = dispatchHarness({ status: 'UNKNOWN' });
  const fake = deterministicProvider({
    [executionId]: {
      k: 'NOT_FOUND_PROVEN',
      reason: 'provider proved absence by key',
    },
  });
  const result = await svc.reconcileUnknown({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.k, 'RETRYABLE_FAILED');
  assert.equal(result.run.status, 'RETRYABLE_FAILED');
  assert.equal(repo.attemptDutyLog[0].command, 'RESOLVE_UNKNOWN_NOT_EXECUTED');
  assert.equal(
    repo.attemptDutyLog[0].detail.reason,
    'provider proved absence by key',
  );
});

test('C3: UNCERTAIN performs zero mutation and demands the operator decision', async () => {
  const { repo, executionId, svc } = dispatchHarness({ status: 'UNKNOWN' });
  const fake = deterministicProvider({ [executionId]: { k: 'UNCERTAIN' } });
  const result = await svc.reconcileUnknown({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.ok, true);
  assert.equal(result.k, 'AWAITING_OPERATOR');
  assert.equal(result.requiresManualResolution, true);
  assert.equal(result.run, null);
  assert.equal(result.providerLookupMade, true);
  assert.equal(repo.rows.get(executionId).status, 'UNKNOWN');
  assert.equal(repo.attemptDutyLog.length, 0);
});

test('C4: FOUND without a usable reference is INVALID evidence (fail closed)', async () => {
  const { repo, executionId, svc } = dispatchHarness({ status: 'UNKNOWN' });
  const fake = deterministicProvider({
    [executionId]: { k: 'FOUND', externalId: '   ' },
  });
  const result = await svc.reconcileUnknown({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.k, 'AWAITING_OPERATOR');
  assert.equal(result.requiresManualResolution, true);
  assert.equal(repo.rows.get(executionId).status, 'UNKNOWN');
});

test('C5: NOT_FOUND_PROVEN without a proof reason fails closed to manual', async () => {
  const { repo, executionId, svc } = dispatchHarness({ status: 'UNKNOWN' });
  const fake = deterministicProvider({
    [executionId]: { k: 'NOT_FOUND_PROVEN', reason: 7 },
  });
  const result = await svc.reconcileUnknown({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.k, 'AWAITING_OPERATOR');
  assert.equal(result.run, null);
});

test('C6: only UNKNOWN rows are probed — never a blind lookup', async () => {
  for (const status of [
    'PENDING',
    'DISPATCHING',
    'SUCCEEDED',
    'RETRYABLE_FAILED',
    'CANCELLED',
    'PERMANENT_FAILED',
  ]) {
    const { repo, executionId, svc } = dispatchHarness({ status });
    const fake = deterministicProvider({});
    const result = await svc.reconcileUnknown({
      executionId,
      provider: fake.port,
    });
    assert.equal(result.reason, 'EXECUTION_STATE_CONFLICT');
    assert.equal(fake.count('lookupExternalByCorrelation'), 0);
    assert.equal(repo.rows.get(executionId).status, status);
  }
});

test('C7: reconcile of a missing execution refuses before the port', async () => {
  const svc = service(inMemoryRepository());
  const fake = deterministicProvider({});
  const result = await svc.reconcileUnknown({
    executionId: 'exec-none',
    provider: fake.port,
  });
  assert.equal(result.reason, 'EXECUTION_NOT_FOUND');
  assert.equal(fake.count('lookupExternalByCorrelation'), 0);
});

test('C8: concurrent reconsolutions race to one settle; the loser refuses', async () => {
  const { repo, executionId, svc } = dispatchHarness({ status: 'UNKNOWN' });
  const fake = deterministicProvider({
    [executionId]: { k: 'FOUND', externalId: 'EXT-RACE' },
  });
  const [first, second] = await Promise.all([
    svc.reconcileUnknown({ executionId, provider: fake.port }),
    svc.reconcileUnknown({ executionId, provider: fake.port }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(first.k, 'SUCCEEDED');
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'EXECUTION_STATE_CONFLICT');
  assert.equal(repo.rows.get(executionId).status, 'SUCCEEDED');
  assert.equal(repo.rows.get(executionId).storedExternalId, 'EXT-RACE');
});

test('C9: a garbage lookup shape is a thrown port violation, row untouched', async () => {
  const { repo, executionId, svc } = dispatchHarness({ status: 'UNKNOWN' });
  const fake = deterministicProvider({
    [executionId]: { __violation: { k: 'SOMETHING_ELSE' } },
  });
  await assert.rejects(
    () => svc.reconcileUnknown({ executionId, provider: fake.port }),
    /provider-port-violation/,
  );
  assert.equal(repo.rows.get(executionId).status, 'UNKNOWN');
});

test('C10: a port without the lookup surface refuses PROVIDER_PORT_REQUIRED', async () => {
  const { repo, executionId, svc } = dispatchHarness({ status: 'UNKNOWN' });

  const result = await svc.reconcileUnknown({
    executionId,
    provider: { executeDispatch: async () => ({ k: 'UNKNOWN_EFFECT' }) },
  });
  assert.equal(result.reason, 'PROVIDER_PORT_REQUIRED');
  assert.equal(repo.rows.get(executionId).status, 'UNKNOWN');
});

test('C11: the full MW-034 chain — UNKNOWN, reconcile, controlled retry, success', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  const fake = deterministicProvider({
    [executionId]: { k: 'UNKNOWN_EFFECT' },
  });
  const dispatchOne = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });
  assert.equal(dispatchOne.k, 'UNKNOWN');
  fake.setOutcome(executionId, {
    k: 'NOT_FOUND_PROVEN',
    reason: 'absence proven',
  });
  const resolved = await svc.reconcileUnknown({
    executionId,
    provider: fake.port,
  });
  assert.equal(resolved.k, 'RETRYABLE_FAILED');
  fake.setOutcome(executionId, { k: 'CONFIRMED', externalId: 'GH-FINAL' });

  const dispatchTwo = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });
  assert.equal(dispatchTwo.k, 'SUCCEEDED');
  assert.equal(dispatchTwo.run.storedExternalId, 'GH-FINAL');

  assert.equal(fake.count('executeDispatch'), 2);
  assert.equal(fake.count('lookupExternalByCorrelation'), 1);
});

test('D1: the same reference re-acknowledges a SUCCEEDED row with zero writes', async () => {
  const { repo, executionId, svc } = dispatchHarness({ status: 'SUCCEEDED' });
  repo.rows.get(executionId).storedExternalId = 'GH-42';
  const writeCountBefore = repo.calls.length;
  const result = await svc.reAcknowledgeSuccess({
    executionId,
    externalRef: 'GH-42',
  });
  assert.equal(result.ok, true);
  assert.equal(result.k, 'REACKNOWLEDGED_SUCCESS');
  assert.equal(result.externalRef, 'GH-42');
  assert.equal(result.idempotentDuplicate, true);
  assert.equal(result.newWrite, false);
  assert.equal(repo.calls.length, writeCountBefore + 1);
  assert.equal(repo.rows.get(executionId).status, 'SUCCEEDED');
});

test('D2: a different reference is MISMATCHED_EXTERNAL_REFERENCE (no overwrite)', async () => {
  const { repo, executionId, svc } = dispatchHarness({ status: 'SUCCEEDED' });
  repo.rows.get(executionId).storedExternalId = 'GH-42';
  const result = await svc.reAcknowledgeSuccess({
    executionId,
    externalRef: 'GH-OTHER',
  });
  assert.equal(result.reason, 'MISMATCHED_EXTERNAL_REFERENCE');
  assert.equal(repo.rows.get(executionId).storedExternalId, 'GH-42');
});

test('D3: a SUCCEEDED row without a stored reference fails closed', async () => {
  const { repo, executionId, svc } = dispatchHarness({ status: 'SUCCEEDED' });
  const result = await svc.reAcknowledgeSuccess({
    executionId,
    externalRef: 'GH-42',
  });
  assert.equal(result.reason, 'MISSING_EXTERNAL_REFERENCE');
});

test('D4: only SUCCEEDED rows re-acknowledge', async () => {
  for (const status of [
    'PENDING',
    'DISPATCHING',
    'UNKNOWN',
    'RETRYABLE_FAILED',
    'CANCELLED',
    'PERMANENT_FAILED',
  ]) {
    const { repo, executionId, svc } = dispatchHarness({ status });
    const result = await svc.reAcknowledgeSuccess({
      executionId,
      externalRef: 'GH-42',
    });
    assert.equal(result.reason, 'EXECUTION_STATE_CONFLICT');
    assert.equal(repo.rows.get(executionId).status, status);
  }
});

test('D5: missing execution / missing reference refuse fail closed', async () => {
  const svc = service(inMemoryRepository());
  assert.equal(
    (
      await svc.reAcknowledgeSuccess({
        executionId: 'exec-none',
        externalRef: 'GH',
      })
    ).reason,
    'EXECUTION_NOT_FOUND',
  );
  const repo = inMemoryRepository();
  const id = repo.seedExecution({
    status: 'SUCCEEDED',
    storedExternalId: 'GH-1',
  });
  assert.equal(
    (
      await service(repo).reAcknowledgeSuccess({
        executionId: id,
        externalRef: '',
      })
    ).reason,
    'MISSING_EXTERNAL_REFERENCE',
  );
});

test('E1: a PENDING route withdraws to CANCELLED with no external call', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  const fake = deterministicProvider({});
  const result = await svc.withdrawRoute({
    executionId,
    reason: 'approver withdrew the route',
  });
  assert.equal(result.ok, true);
  assert.equal(result.k, 'ROUTE_WITHDRAWN');
  assert.equal(result.run.status, 'CANCELLED');
  assert.equal(result.noExternalCall, true);
  assert.equal(fake.count('executeDispatch'), 0);
  assert.equal(
    repo.attemptDutyLog[0].detail.auditReason,
    'approver withdrew the route',
  );
});

test('E2: RETRYABLE_FAILED withdraws to CANCELLED after the failed attempt', async () => {
  const { repo, executionId, svc } = dispatchHarness({
    status: 'RETRYABLE_FAILED',
  });
  const result = await svc.withdrawRoute({
    executionId,
    reason: 'route no longer wanted',
  });
  assert.equal(result.k, 'ROUTE_WITHDRAWN');
  assert.equal(result.run.status, 'CANCELLED');
});

test('E3: a withdrawal without its reason refuses MISSING_FAILURE_REASON', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  const result = await svc.withdrawRoute({ executionId, reason: undefined });
  assert.equal(result.reason, 'MISSING_FAILURE_REASON');
  assert.equal(repo.rows.get(executionId).status, 'PENDING');
});

test('E4: a blank reason refuses MISSING_FAILURE_REASON', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  const result = await svc.withdrawRoute({ executionId, reason: '   ' });
  assert.equal(result.reason, 'MISSING_FAILURE_REASON');
});

test('E5: withdrawal after dispatch landed is refused (row 92)', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  repo.rows.get(executionId).status = 'DISPATCHING';
  const result = await svc.withdrawRoute({ executionId, reason: 'too late' });

  assert.equal(result.reason, 'UNAUTHORIZED');
  assert.equal(repo.rows.get(executionId).status, 'DISPATCHING');
});

test('E6: terminal rows never re-accept a withdrawal', async () => {
  for (const status of [
    'SUCCEEDED',
    'PERMANENT_FAILED',
    'CANCELLED',
    'UNKNOWN',
  ]) {
    const { repo, executionId, svc } = dispatchHarness({ status });
    const result = await svc.withdrawRoute({ executionId, reason: 'why not' });
    assert.equal(result.reason, 'UNAUTHORIZED');
    assert.equal(repo.rows.get(executionId).status, status);
  }
});

test('E7: the losing withdrawal of a claim race refuses with zero mutation', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  repo.hooks.beforeWithdrawStatusRecheck = () => {
    repo.rows.get(executionId).status = 'DISPATCHING';
    repo.rows.get(executionId).storedExternalId = null;
  };
  const result = await svc.withdrawRoute({ executionId, reason: 'race loser' });
  assert.equal(result.reason, 'EXECUTION_STATE_CONFLICT');
  assert.equal(repo.rows.get(executionId).status, 'DISPATCHING');
});

test('E8: a withdrawal won races the dispatch off the provider path', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  repo.hooks.beforeClaimStatusRecheck = () => {
    repo.rows.get(executionId).status = 'CANCELLED';
  };
  const fake = deterministicProvider({
    [executionId]: { k: 'CONFIRMED', externalId: 'GH-RACE' },
  });
  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'EXECUTION_STATE_CONFLICT');
  assert.equal(fake.count('executeDispatch'), 0);
  assert.equal(repo.rows.get(executionId).status, 'CANCELLED');
});

test('F1: every service outcome and failure is frozen', async () => {
  const repo = inMemoryRepository();
  repo.seedItem('item-1', {});
  repo.seedConnection('conn-1', true);
  const svc = service(repo);
  const created = await svc.requestExecutionRoute(createRouteInput({}));
  assert.ok(Object.isFrozen(created));
  const failure = await svc.requestExecutionRoute(null);
  assert.ok(Object.isFrozen(failure));
});

test('F2: planted caller booleans and states can never become authority', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  const fake = deterministicProvider({
    [executionId]: { k: 'UNKNOWN_EFFECT' },
  });

  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
    authorized: true,
    currentState: 'SUCCEEDED',
    command: 'CONFIRM_SUCCESS',
    externalRef: 'FABRICATED-REF',
  });
  assert.equal(result.k, 'UNKNOWN');
  assert.equal(result.run.storedExternalId, null);
});

test('F3: contract methods exist exactly as documented (shape)', () => {
  const repo = inMemoryRepository();
  assert.equal(typeof repo.getExecutionFacts, 'function');
  assert.equal(typeof repo.createExecutionRequest, 'function');
  assert.equal(typeof repo.claimExecution, 'function');
  assert.equal(typeof repo.settleDispatchOutcome, 'function');
  assert.equal(typeof repo.resolveUnknown, 'function');
  assert.equal(typeof repo.withdrawExecution, 'function');
});

test('G1: an enum-corrupt stored status throws at the fresh facts read', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  repo.rows.get(executionId).status = 'FROBNICATED';
  const fake = deterministicProvider({});
  await assert.rejects(
    () => svc.dispatchExecution({ executionId, provider: fake.port }),
    /execution-request-row-mapping-corrupt \(status FROBNICATED\)/,
  );

  assert.equal(
    repo.calls.some((c) => c.method === 'claimExecution'),
    false,
  );
  assert.equal(fake.count('executeDispatch'), 0);
});

test('G2: corruption planted AT the claim re-read throws without a grant', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  repo.hooks.beforeClaimStatusRecheck = ({ row }) => {
    if (row.status === 'PENDING') {
      row.status = 'WIBBLE';
    }
  };
  const fake = deterministicProvider({
    [executionId]: { k: 'CONFIRMED', externalId: 'GH-X' },
  });
  await assert.rejects(
    () => svc.dispatchExecution({ executionId, provider: fake.port }),
    /execution-request-row-mapping-corrupt/,
  );

  assert.equal(repo.rows.get(executionId).status, 'WIBBLE');
  assert.equal(fake.count('executeDispatch'), 0);
});

test('G3: corruption planted at the settle re-read throws before any write', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  repo.hooks.beforeSettleRecheck = ({ row }) => {
    if (row.status === 'DISPATCHING') {
      row.status = 'WIBBLE';
    }
  };
  const fake = deterministicProvider({
    [executionId]: { k: 'CONFIRMED', externalId: 'GH-Y' },
  });
  await assert.rejects(
    () => svc.dispatchExecution({ executionId, provider: fake.port }),
    /execution-request-row-mapping-corrupt/,
  );

  assert.equal(repo.attemptDutyLog.length, 0);
  assert.equal(repo.rows.get(executionId).status, 'WIBBLE');
});

test('G4: corruption planted at the resolve re-read throws, same doctrine', async () => {
  const { repo, executionId, svc } = dispatchHarness({ status: 'UNKNOWN' });
  repo.hooks.beforeResolveStatusRecheck = ({ row }) => {
    if (row.status === 'UNKNOWN') {
      row.status = 'WIBBLE';
    }
  };
  const fake = deterministicProvider({
    [executionId]: { k: 'FOUND', externalId: 'EXT-G' },
  });
  await assert.rejects(
    () => svc.reconcileUnknown({ executionId, provider: fake.port }),
    /execution-request-row-mapping-corrupt/,
  );
  assert.equal(repo.attemptDutyLog.length, 0);
  assert.equal(repo.rows.get(executionId).status, 'WIBBLE');
});

test('G5: a row vanishing in-tx during claim refuses as EXECUTION_STATE_CONFLICT', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  repo.hooks.beforeClaimStatusRecheck = () => {
    repo.rows.delete(executionId);
  };
  const fake = deterministicProvider({
    [executionId]: { k: 'CONFIRMED', externalId: 'GH-V' },
  });
  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'EXECUTION_STATE_CONFLICT');
  assert.equal(fake.count('executeDispatch'), 0);
  assert.equal(repo.rows.has(executionId), false);
});

test('G6: a row vanishing at the settle re-read refuses without resurrection', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  repo.hooks.beforeSettleRecheck = () => {
    repo.rows.delete(executionId);
  };
  const fake = deterministicProvider({
    [executionId]: { k: 'CONFIRMED', externalId: 'GH-V2' },
  });
  const result = await svc.dispatchExecution({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.reason, 'EXECUTION_STATE_CONFLICT');
  assert.equal(repo.attemptDutyLog.length, 0);
  assert.equal(repo.rows.has(executionId), false);
});

test('G7: a row vanishing at the resolve re-read refuses without resurrection', async () => {
  const { repo, executionId, svc } = dispatchHarness({ status: 'UNKNOWN' });
  repo.hooks.beforeResolveStatusRecheck = () => {
    repo.rows.delete(executionId);
  };
  const fake = deterministicProvider({
    [executionId]: { k: 'NOT_FOUND_PROVEN', reason: 'absence proven' },
  });
  const result = await svc.reconcileUnknown({
    executionId,
    provider: fake.port,
  });
  assert.equal(result.reason, 'EXECUTION_STATE_CONFLICT');
  assert.equal(repo.attemptDutyLog.length, 0);
  assert.equal(repo.rows.has(executionId), false);
});

test('G8: a row vanishing at the withdraw re-read refuses without a write', async () => {
  const { repo, executionId, svc } = dispatchHarness();
  repo.hooks.beforeWithdrawStatusRecheck = () => {
    repo.rows.delete(executionId);
  };
  const result = await svc.withdrawRoute({ executionId, reason: 'gone' });
  assert.equal(result.reason, 'EXECUTION_STATE_CONFLICT');
  assert.equal(repo.attemptDutyLog.length, 0);
  assert.equal(repo.rows.has(executionId), false);
});
