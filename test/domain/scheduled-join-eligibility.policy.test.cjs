const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ScheduledJoinEligibilityPolicy,
} = require('../../libs/meetings/src/domain/scheduled-join-eligibility.policy.ts');
const policy = new ScheduledJoinEligibilityPolicy();
const now = 1900000000000;
function fixture(kind = 'TECH') {
  return {
    job: { occurrenceId: 'occurrence-1', scheduleVersion: 2 },
    occurrence: {
      id: 'occurrence-1',
      kind,
      departmentId: kind === 'GENERAL' ? null : `department-${kind}`,
      lifecycle: 'SCHEDULED',
      scheduleVersion: 2,
      scheduledAt: now,
    },
    department:
      kind === 'GENERAL'
        ? null
        : { id: `department-${kind}`, kind, status: 'ACTIVE' },
    readiness: {
      supportedMeetLink: true,
      providerEnabled: true,
      providerConfigurationValid: true,
      capturePolicy: 'PERMITTED',
    },
  };
}
const decide = (value, instant = now) =>
  policy.evaluate(
    value.job,
    value.occurrence,
    value.department,
    value.readiness,
    instant,
  );
const denied = (reason) => ({ eligible: false, reason });
for (const kind of ['TECH', 'SALES', 'GENERAL']) {
  test(`due ${kind} with current synthetic prerequisites is conditionally eligible`, () => {
    assert.deepEqual(decide(fixture(kind)), {
      eligible: true,
      occurrenceId: 'occurrence-1',
      scheduleVersion: 2,
    });
  });
}
test('future occurrence is not dispatched early', () => {
  assert.deepEqual(decide(fixture(), now - 1), denied('NOT_DUE'));
});
test('overdue occurrence has no invented maximum lateness window', () => {
  assert.equal(decide(fixture(), now + 3600000).eligible, true);
});
for (const change of [
  { occurrenceId: 'other' },
  { scheduleVersion: 1 },
  { scheduleVersion: -1 },
  { scheduleVersion: 2.5 },
  { scheduleVersion: Number.MAX_SAFE_INTEGER + 1 },
]) {
  test(`rejects stale or invalid job identity/version ${JSON.stringify(change)}`, () => {
    const value = fixture();
    Object.assign(value.job, change);
    assert.deepEqual(decide(value), denied('STALE_JOB'));
  });
}
for (const lifecycle of [
  'DRAFT',
  'IN_PROGRESS',
  'ENDED',
  'CANCELLED',
  'unknown',
]) {
  test(`lifecycle ${lifecycle} cannot begin scheduled dispatch`, () => {
    const value = fixture();
    value.occurrence.lifecycle = lifecycle;
    assert.deepEqual(decide(value), denied('INELIGIBLE_LIFECYCLE'));
  });
}
for (const status of ['DISABLED', 'CONFIGURING', 'SUSPENDED', 'unknown']) {
  test(`department ${status} is not active`, () => {
    const value = fixture();
    value.department.status = status;
    assert.deepEqual(decide(value), denied('INELIGIBLE_DEPARTMENT'));
  });
}
for (const department of [
  null,
  { id: 'other', kind: 'TECH', status: 'ACTIVE' },
  { id: 'department-TECH', kind: 'SALES', status: 'ACTIVE' },
]) {
  test(`missing or cross-scope department is denied ${JSON.stringify(department)}`, () => {
    const value = fixture();
    value.department = department;
    assert.deepEqual(decide(value), denied('INELIGIBLE_DEPARTMENT'));
  });
}
test('GENERAL cannot carry a department ID', () => {
  const value = fixture('GENERAL');
  value.occurrence.departmentId = 'department-TECH';
  assert.deepEqual(decide(value), denied('INELIGIBLE_DEPARTMENT'));
});
test('GENERAL cannot receive unrelated resolved department facts', () => {
  const value = fixture('GENERAL');
  value.department = fixture().department;
  assert.deepEqual(decide(value), denied('INELIGIBLE_DEPARTMENT'));
});
for (const field of [
  'supportedMeetLink',
  'providerEnabled',
  'providerConfigurationValid',
]) {
  test(`readiness ${field} must be explicitly true`, () => {
    const value = fixture();
    value.readiness[field] = false;
    assert.deepEqual(decide(value), denied('CAPTURE_NOT_READY'));
    value.readiness[field] = 'true';
    assert.deepEqual(decide(value), denied('CAPTURE_NOT_READY'));
  });
}
for (const capturePolicy of ['DENIED', 'UNRESOLVED', '', null]) {
  test(`capture policy ${String(capturePolicy)} denies without inventing consent`, () => {
    const value = fixture();
    value.readiness.capturePolicy = capturePolicy;
    assert.deepEqual(decide(value), denied('CAPTURE_NOT_READY'));
  });
}
for (const instant of [NaN, Infinity, -Infinity]) {
  test(`invalid current time ${String(instant)} fails closed`, () => {
    assert.deepEqual(decide(fixture(), instant), denied('INVALID_TIME'));
  });
}
test('invalid stored scheduled instant fails closed', () => {
  const value = fixture();
  value.occurrence.scheduledAt = NaN;
  assert.deepEqual(decide(value), denied('INVALID_TIME'));
});
test('unknown kind fails closed', () => {
  assert.deepEqual(decide(fixture('HR')), denied('INELIGIBLE_DEPARTMENT'));
});
test('reschedule then department disable invalidates earlier eligibility on each evaluation', () => {
  const value = fixture();
  assert.equal(decide(value).eligible, true);
  value.occurrence.scheduleVersion++;
  assert.deepEqual(decide(value), denied('STALE_JOB'));
  value.job.scheduleVersion++;
  value.department.status = 'DISABLED';
  assert.deepEqual(decide(value), denied('INELIGIBLE_DEPARTMENT'));
});
test('frozen inputs remain unchanged; result contains only immutable occurrence identity', () => {
  const value = fixture();
  Object.values(value).forEach(Object.freeze);
  const result = decide(value);
  assert.ok(Object.isFrozen(result));
  assert.equal(Reflect.set(result, 'scheduleVersion', 3), false);
  assert.deepEqual(Object.keys(result).sort(), [
    'eligible',
    'occurrenceId',
    'scheduleVersion',
  ]);
  assert.equal(value.occurrence.scheduleVersion, 2);
});
