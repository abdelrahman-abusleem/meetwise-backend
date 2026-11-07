const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CancellationDecisionStore,
} = require('../../apps/api/src/modules/meetings/cancellation-decision.store.ts');
const meetingId = '11111111-1111-4111-8111-111111111111',
  requestId = '22222222-2222-4222-8222-222222222222';
function transaction() {
  const events = [];
  return {
    events,
    async $executeRaw(strings, ...values) {
      events.push({ sql: strings.join('?'), values });
      return 1;
    },
  };
}
test('prestart approval persists both canonical cancellation and decision intents with ID/version-only payloads', async () => {
  const tx = transaction();
  await new CancellationDecisionStore().appendOutbox(
    tx,
    requestId,
    meetingId,
    5,
    8,
  );
  assert.equal(tx.events.length, 2);
  const cancellation = tx.events.find((event) =>
    event.sql.includes("'meeting.cancelled.v1'"),
  );
  assert(cancellation, 'Missing canonical meeting cancellation intent');
  assert.equal(cancellation.values[2], 5);
  assert.deepEqual(JSON.parse(cancellation.values.at(-1)), {
    meetingId,
    scheduleVersion: 8,
  });
  const decision = tx.events.find((event) =>
    event.sql.includes("'cancellation.decided.v1'"),
  );
  assert(decision);
  assert.equal(decision.values[2], 5);
  assert.deepEqual(JSON.parse(decision.values.at(-1)), {
    meetingId,
    requestId,
  });
});
test('rejection persists only the decision intent and never a cancellation', async () => {
  const tx = transaction();
  await new CancellationDecisionStore().appendOutbox(
    tx,
    requestId,
    meetingId,
    4,
  );
  assert.equal(tx.events.length, 1);
  assert(tx.events[0].sql.includes("'cancellation.decided.v1'"));
});
