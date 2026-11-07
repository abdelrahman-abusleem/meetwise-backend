const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  BotJoinDispatchService,
} = require('../../libs/meetings/src/application/bot-join.service.ts');
const {
  BotJoinEligibilityPolicy,
} = require('../../libs/meetings/src/domain/bot-join-eligibility.policy.ts');
for (const flag of [true, false]) {
  test(`legacy authorization boolean ${flag} cannot replace actor context`, async () => {
    let reads = 0;
    const service = new BotJoinDispatchService(
      {
        async loadRequeueRecord() {
          reads++;
          throw new Error('synthetic-storage-call');
        },
      },
      {},
      new BotJoinEligibilityPolicy(),
    );
    await assert.rejects(
      service.requeueForRetrigger('synthetic-meeting', {
        dispatchAt: '2026-11-03T00:00:00Z',
        callerAuthorizedForRetrigger: flag,
      }),
      /bot-join-invalid-request/,
    );
    assert.equal(reads, 0);
  });
}
