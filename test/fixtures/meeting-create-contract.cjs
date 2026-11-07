const assert = require('node:assert/strict');
function assertCreatedMeeting(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  const keys = [
    'id',
    'kind',
    'departmentId',
    'visibility',
    'title',
    'createdById',
    'meetingAdminId',
    'lifecycle',
    'version',
    'scheduleVersion',
    'scheduledAt',
  ];
  assert.deepEqual(Object.keys(value).sort(), keys.sort());
  for (const key of ['id', 'createdById', 'meetingAdminId'])
    assert.match(
      value[key],
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
    );
  assert.ok(['GENERAL', 'TECH', 'SALES'].includes(value.kind));
  assert.ok(['COMPANY', 'DEPARTMENT', 'PRIVATE'].includes(value.visibility));
  assert.equal(typeof value.title, 'string');
  assert.ok(value.title.trim().length > 0 && value.title.length <= 240);
  assert.equal(value.lifecycle, 'DRAFT');
  assert.equal(value.version, 0);
  assert.equal(value.scheduleVersion, 0);
  if (value.kind === 'GENERAL') {
    assert.equal(value.departmentId, null);
    assert.notEqual(value.visibility, 'DEPARTMENT');
  } else {
    assert.match(value.departmentId, /^[a-f0-9-]{36}$/i);
    assert.notEqual(value.visibility, 'COMPANY');
  }
  assert.ok(
    value.scheduledAt === null ||
      (typeof value.scheduledAt === 'string' &&
        Number.isFinite(Date.parse(value.scheduledAt))),
  );
}
module.exports = { assertCreatedMeeting };
