import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Job, Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

import { SystemProcessor } from '../../../../apps/worker/src/processors/system.processor';
import { QUEUE_NAMES, SmokeTestJobData, SYSTEM_JOB_NAMES } from '../src';

interface QueueFixture {
  queue: Queue<SmokeTestJobData>;
  events: QueueEvents;
  startWorker: () => Promise<Queue<SmokeTestJobData>>;
}

const COMPLETION_TIMEOUT_MS = 5000;

async function withinDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Queue fixture deadline exceeded')),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function disposableConnection() {
  const rawPort = process.env.MEETWISE_RESET_TEST_REDIS_PORT;
  const port = Number(rawPort);
  if (!rawPort || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('An explicit disposable Redis port is required');
  }
  return {
    host: '127.0.0.1',
    port,
    connectTimeout: 1000,
    retryStrategy: () => null,
  };
}

async function withQueueFixture(
  verify: (fixture: QueueFixture) => Promise<void>,
): Promise<void> {
  const connection = disposableConnection();
  const prefix = `mw-queue-test-${randomUUID()}`;
  const queue = new Queue<SmokeTestJobData>(QUEUE_NAMES.SYSTEM, {
    connection,
    prefix,
  });
  const events = new QueueEvents(QUEUE_NAMES.SYSTEM, { connection, prefix });
  const inventory = new Redis({
    ...connection,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  let module: TestingModule | undefined;
  const errors: unknown[] = [];

  try {
    await withinDeadline(
      Promise.all([
        queue.waitUntilReady(),
        events.waitUntilReady(),
        inventory.connect(),
      ]),
    );
    await verify({
      queue,
      events,
      startWorker: async () => {
        if (module) throw new Error('Fixture worker already started');
        module = await Test.createTestingModule({
          imports: [
            BullModule.forRoot({ connection, prefix }),
            BullModule.registerQueue({ name: QUEUE_NAMES.SYSTEM }),
          ],
          providers: [SystemProcessor],
        }).compile();
        await withinDeadline(module.init());
        await withinDeadline(
          module.get(SystemProcessor).worker.waitUntilReady(),
        );
        return module.get<Queue<SmokeTestJobData>>(
          getQueueToken(QUEUE_NAMES.SYSTEM),
        );
      },
    });
  } catch (error) {
    errors.push(error);
  } finally {
    for (const close of [
      async () => {
        if (module) await module.close();
      },
      async () => events.close(),
      async () => {
        if (
          queue.opts.prefix !== prefix ||
          !prefix.startsWith('mw-queue-test-')
        ) {
          throw new Error('Queue fixture ownership mismatch; refusing cleanup');
        }
        await queue.obliterate({ force: true });
        const remaining = await inventory.keys(`${prefix}:*`);
        if (remaining.length) throw new Error('Owned queue keys remain');
      },
      async () => queue.close(),
      () => inventory.disconnect(),
    ]) {
      try {
        await withinDeadline(Promise.resolve(close()));
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Queue verification failed');
}

function smokeData(message: string): SmokeTestJobData {
  return { message, sentAt: new Date().toISOString() };
}

describe('System Worker (real Nest adapter and disposable Redis)', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => consoleSpy.mockRestore());

  it('processes a smoke job through the actual Nest-injected queue and processor', async () => {
    await withQueueFixture(async ({ events, startWorker }) => {
      const injectedQueue = await startWorker();
      const data = smokeData('synthetic-smoke');
      const job = await injectedQueue.add(SYSTEM_JOB_NAMES.SMOKE_TEST, data);

      await job.waitUntilFinished(events, COMPLETION_TIMEOUT_MS);

      expect(await job.getState()).toBe('completed');
      expect(consoleSpy).toHaveBeenCalledWith(
        'Worker received smoke-test job:',
        data,
      );
    });
  });

  it('marks unknown jobs failed with the actual processor error', async () => {
    await withQueueFixture(async ({ events, startWorker }) => {
      const queue = await startWorker();
      const job = await queue.add('unknown-system-job', smokeData('synthetic'));

      await expect(
        job.waitUntilFinished(events, COMPLETION_TIMEOUT_MS),
      ).rejects.toThrow('Unknown system job: unknown-system-job');

      expect(await job.getState()).toBe('failed');
      const stored = await Job.fromId(queue, job.id!);
      expect(stored?.failedReason).toBe(
        'Unknown system job: unknown-system-job',
      );
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  it('retains one original job for duplicate IDs submitted before processing', async () => {
    await withQueueFixture(async ({ queue, events, startWorker }) => {
      const jobId = randomUUID();
      const originalData = smokeData('original-synthetic-message');
      const original = await queue.add(
        SYSTEM_JOB_NAMES.SMOKE_TEST,
        originalData,
        {
          jobId,
        },
      );
      await queue.add(SYSTEM_JOB_NAMES.SMOKE_TEST, smokeData('duplicate'), {
        jobId,
      });

      expect(await queue.getWaitingCount()).toBe(1);
      expect((await Job.fromId(queue, jobId))?.data).toEqual(originalData);

      await startWorker();
      await original.waitUntilFinished(events, COMPLETION_TIMEOUT_MS);

      expect(await queue.getCompletedCount()).toBe(1);
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        'Worker received smoke-test job:',
        originalData,
      );
    });
  });

  it('consumes a pending job after a Worker starts following downtime', async () => {
    await withQueueFixture(async ({ queue, events, startWorker }) => {
      const data = smokeData('queued-while-worker-absent');
      const job = await queue.add(SYSTEM_JOB_NAMES.SMOKE_TEST, data);

      expect(await job.getState()).toBe('waiting');
      expect(await queue.getActiveCount()).toBe(0);
      expect(consoleSpy).not.toHaveBeenCalled();

      await startWorker();
      await job.waitUntilFinished(events, COMPLETION_TIMEOUT_MS);

      expect(await job.getState()).toBe('completed');
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });
  });
});
