const path = require('node:path');
const { Test } = require('@nestjs/testing');
const { BullModule, Processor } = require('@nestjs/bullmq');
const root = path.resolve(__dirname, '../../../../..');
const { SystemProcessor } = require(
  path.join(root, 'apps/worker/src/processors/system.processor'),
);
const port = Number(process.argv[2]);
const prefix = process.argv[3];
if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !/^mw-crash-test-[a-f0-9-]{36}$/.test(prefix)
)
  throw new Error('Explicit owned disposable queue configuration required');

setTimeout(() => process.exit(2), 15000).unref();
class HoldingWorker extends SystemProcessor {
  async process(job) {
    await super.process(job);
    process.send?.({ type: 'entered', jobId: job.id, pid: process.pid });

    await new Promise(() => {});
  }
}
Processor('system', {
  lockDuration: 800,
  stalledInterval: 400,
  maxStalledCount: 1,
})(HoldingWorker);
void (async () => {
  const module = await Test.createTestingModule({
    imports: [
      BullModule.forRoot({ connection: { host: '127.0.0.1', port }, prefix }),
      BullModule.registerQueue({ name: 'system' }),
    ],
    providers: [HoldingWorker],
  }).compile();
  await module.init();
  await module.get(HoldingWorker).worker.waitUntilReady();
  process.send?.({ type: 'ready', pid: process.pid });
})().catch(() => {
  process.send?.({ type: 'startup-error', pid: process.pid });
  process.exitCode = 2;
});
