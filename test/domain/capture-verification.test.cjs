const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CaptureSessionService,
} = require('../../libs/meetings/src/application/capture-session.service.ts');
const base = {
  botSessionId: 'synthetic-session',
  eventId: 'synthetic-event',
  eventKind: 'ADMITTED',
  eventTimestampUtc: '2026-11-02T00:00:00Z',
  sequenceNumber: 2,
};
test('missing or malformed trusted verification denies before any repository read/write', async () => {
  for (const verification of [
    undefined,
    false,
    null,
    0,
    1,
    '',
    'true',
    {},
    [],
  ]) {
    let reads = 0,
      writes = 0;
    const service = new CaptureSessionService({
      loadSessionRecord: async () => {
        reads++;
        return null;
      },
      applyCaptureEventTransition: async () => {
        writes++;
        throw new Error('Unexpected write');
      },
    });
    const input = { ...base };
    if (verification !== undefined)
      input.providerSignatureVerified = verification;
    assert.deepEqual(await service.processCaptureEvent(input), {
      kind: 'REFUSED_DOWNSTREAM',
      label: 'UNAUTHENTICATED',
    });
    assert.equal(reads, 0);
    assert.equal(writes, 0);
  }
});
test('explicit trusted verification preserves the authorized transition', async () => {
  const session = {
    id: base.botSessionId,
    meetingId: 'synthetic-meeting',
    state: 'JOINING',
    idempotencyKey: 'synthetic-key',
    captureGeneration: 1,
    admissionState: null,
    lastSequenceNumber: 1,
    lastProcessedEventId: null,
  };
  let writes = 0;
  const service = new CaptureSessionService({
    loadSessionRecord: async () => session,
    applyCaptureEventTransition: async (_id, command) => {
      writes++;
      return {
        ok: true,
        session: {
          ...session,
          state: command.targetState,
          admissionState: command.newAdmissionState,
        },
      };
    },
  });
  assert.equal(
    (
      await service.processCaptureEvent({
        ...base,
        providerSignatureVerified: true,
      })
    ).kind,
    'TRANSITIONED',
  );
  assert.equal(writes, 1);
});
