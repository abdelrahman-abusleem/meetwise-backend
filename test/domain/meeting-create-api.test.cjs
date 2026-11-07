const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ValidationPipe } = require('@nestjs/common');
const {
  CreateMeetingDto,
} = require('../../apps/api/src/modules/meetings/create-meeting.dto.ts');
const {
  validateDraftMetadata,
  meetingRequestIdentity,
} = require('../../apps/api/src/modules/meetings/meeting-input.ts');
const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});
const validate = (body) =>
  pipe.transform(body, { type: 'body', metatype: CreateMeetingDto });
test('accepts minimal GENERAL draft without guests or authorization claims', async () => {
  assert.equal(
    (await validate({ kind: 'GENERAL', title: 'Planning' })).kind,
    'GENERAL',
  );
});
for (const body of [
  { kind: 'GENERAL', title: '' },
  { kind: 'GENERAL', title: 'a'.repeat(241) },
  { kind: 'GENERAL', title: 12 },
  { kind: 'HR', title: 'x' },
  { kind: 'GENERAL', title: 'x', departmentId: null },
  { kind: 'GENERAL', title: 'x', meetingAdminId: 'not-a-uuid' },
  { kind: 'GENERAL', title: 'x', createdById: 'client' },
  { kind: 'GENERAL', title: 'x', role: 'OWNER' },
  { kind: 'GENERAL', title: 'x', scheduledAt: 'not-a-date' },
  { kind: 'GENERAL', title: 'x', scheduledAt: '2030-01-01' },
  { kind: 'GENERAL', title: 'x', scheduledAt: '2030-01-01T09:00:00' },
  { kind: 'GENERAL', title: 'x', scheduledAt: '2030-02-30T09:00:00Z' },
])
  test(`strict DTO rejects invalid or privileged fields ${JSON.stringify(body)}`, async () => {
    await assert.rejects(validate(body), (error) => error.getStatus() === 400);
  });
test('supported draft metadata parses without triggering scheduling', () => {
  assert.deepEqual(
    validateDraftMetadata({
      kind: 'GENERAL',
      title: ' x ',
      scheduledAt: '2030-01-01T09:00:00Z',
      timeZone: 'Africa/Cairo',
      joinUrl: 'https://meet.google.com/abc-defg-hij',
    }),
    {
      title: 'x',
      scheduledAt: new Date('2030-01-01T09:00:00Z'),
      timeZone: 'Africa/Cairo',
      joinUrl: 'https://meet.google.com/abc-defg-hij',
    },
  );
});
for (const scheduledAt of [
  '2030-01-01',
  '2030-01-01T09:00:00',
  '2030-02-30T09:00:00Z',
]) {
  test(`service rejects timestamp without explicit offset (${scheduledAt})`, () => {
    assert.throws(
      () => validateDraftMetadata({ kind: 'GENERAL', title: 'x', scheduledAt }),
      (error) => error.getStatus() === 422,
    );
  });
}
test('explicit numeric offset resolves to the same instant as UTC', () => {
  const value = validateDraftMetadata({
    kind: 'GENERAL',
    title: 'x',
    scheduledAt: '2030-01-01T12:00:00+03:00',
  });
  assert.equal(value.scheduledAt.toISOString(), '2030-01-01T09:00:00.000Z');
});
for (const change of [
  { title: '   ' },
  { timeZone: 'Unknown/Zone' },
  { joinUrl: 'https://example.invalid/abc-defg-hij' },
  { joinUrl: 'http://meet.google.com/abc-defg-hij' },
  { seriesId: '11111111-1111-4111-8111-111111111111' },
]) {
  test(`invalid/unsupported draft metadata fails explicitly ${JSON.stringify(change)}`, () => {
    assert.throws(
      () => validateDraftMetadata({ kind: 'GENERAL', title: 'x', ...change }),
      (error) => error.getStatus() === 422,
    );
  });
}
test('request identity is stable across property ordering and never stores the raw key', () => {
  const a = meetingRequestIdentity('synthetic-key', {
    kind: 'GENERAL',
    title: 'x',
  });
  const b = meetingRequestIdentity('synthetic-key', {
    title: 'x',
    kind: 'GENERAL',
  });
  assert.deepEqual(a, b);
  assert.match(a.keyHash, /^[a-f0-9]{64}$/);
  assert.match(a.payloadHash, /^[a-f0-9]{64}$/);
});
for (const key of [undefined, '', 'a'.repeat(129), ['key']])
  test('invalid idempotency header is rejected', () => {
    assert.throws(
      () => meetingRequestIdentity(key, { kind: 'GENERAL', title: 'x' }),
      (error) => error.getStatus() === 400,
    );
  });
