import { BullModule, Processor } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Job, Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { SystemProcessor } from '../../../../apps/worker/src/processors/system.processor';
import { QUEUE_NAMES, SYSTEM_JOB_NAMES, SmokeTestJobData } from '../src';

@Processor(QUEUE_NAMES.SYSTEM, {
  lockDuration: 800,
  stalledInterval: 400,
  maxStalledCount: 1,
})
class RecoveryWorker extends SystemProcessor {}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error('Owned crash fixture operation deadline exceeded'),
            ),
          6000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 6000;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error('Owned crash fixture deadline exceeded');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface HoldingProcess {
  child: ChildProcess;
  closed: Promise<void>;
  messages: Array<{ type: string; jobId?: string }>;
}
interface Fixture {
  queue: Queue<SmokeTestJobData>;
  events: QueueEvents;
  inventory: Redis;
  prefix: string;
  stalled: string[];
  hold: () => Promise<HoldingProcess>;
  crash: (worker: HoldingProcess, job: Job<SmokeTestJobData>) => Promise<void>;
  recover: () => Promise<void>;
}

async function withCrashFixture(verify: (fixture: Fixture) => Promise<void>) {
  const rawPort = process.env.MEETWISE_RESET_TEST_REDIS_PORT;
  const port = Number(rawPort);
  if (!rawPort || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('An explicit disposable Redis port is required');
  const connection = {
    host: '127.0.0.1',
    port,
    connectTimeout: 1000,
    retryStrategy: () => null,
  };
  const prefix = `mw-crash-test-${randomUUID()}`;
  const queue = new Queue<SmokeTestJobData>(QUEUE_NAMES.SYSTEM, {
    connection,
    prefix,
  });
  const events = new QueueEvents(QUEUE_NAMES.SYSTEM, { connection, prefix });
  const inventory = new Redis({
    ...connection,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  const sentinel = `mw-crash-sentinel-${randomUUID()}`;
  const children: HoldingProcess[] = [];
  const stalled: string[] = [];
  events.on('stalled', ({ jobId }) => stalled.push(jobId));
  let module: TestingModule | undefined;
  const failures: unknown[] = [];
  try {
    await bounded(
      Promise.all([
        queue.waitUntilReady(),
        events.waitUntilReady(),
        inventory.connect(),
      ]),
    );
    await inventory.set(sentinel, 'synthetic-untouched');
    await verify({
      queue,
      events,
      inventory,
      prefix,
      stalled,
      hold: async () => {
        const child = fork(
          path.join(__dirname, 'fixtures/holding-worker.cjs'),
          [String(port), prefix],
          {
            cwd: path.resolve(__dirname, '../../../..'),
            env: { ...process.env },
            execArgv: [
              '-r',
              'ts-node/register/transpile-only',
              '-r',
              'tsconfig-paths/register',
            ],
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          },
        );
        const messages: HoldingProcess['messages'] = [];
        child.on('message', (value: unknown) => {
          if (
            value &&
            typeof value === 'object' &&
            'pid' in value &&
            value.pid === child.pid &&
            'type' in value &&
            typeof value.type === 'string'
          ) {
            messages.push({
              type: value.type,
              jobId:
                'jobId' in value && typeof value.jobId === 'string'
                  ? value.jobId
                  : undefined,
            });
          }
        });
        child.on('error', () => messages.push({ type: 'startup-error' }));
        const closed = new Promise<void>((resolve) =>
          child.once('close', () => resolve()),
        );
        const owned = { child, closed, messages };
        children.push(owned);
        await until(() => {
          if (
            messages.some((m) => m.type === 'startup-error') ||
            child.exitCode !== null
          )
            throw new Error('Owned child Worker failed to start');
          return messages.some((m) => m.type === 'ready');
        });
        return owned;
      },
      crash: async (worker, job) => {
        await until(() =>
          worker.messages.some(
            (m) => m.type === 'entered' && m.jobId === job.id,
          ),
        );
        expect(await job.getState()).toBe('active');
        const lock = `${queue.toKey(job.id!)}:lock`;
        let previous = await inventory.pttl(lock);
        expect(previous).toBeGreaterThan(0);
        await until(async () => {
          const current = await inventory.pttl(lock);
          const renewed = current > previous + 100;
          previous = current;
          return renewed;
        });
        expect(worker.child.kill('SIGKILL')).toBe(true);
        await bounded(worker.closed);
        expect(
          worker.child.signalCode === 'SIGKILL' || worker.child.exitCode !== 0,
        ).toBe(true);
      },
      recover: async () => {
        module = await Test.createTestingModule({
          imports: [
            BullModule.forRoot({ connection, prefix }),
            BullModule.registerQueue({ name: QUEUE_NAMES.SYSTEM }),
          ],
          providers: [RecoveryWorker],
        }).compile();
        await bounded(module.init());
        await bounded(module.get(RecoveryWorker).worker.waitUntilReady());
      },
    });
  } catch (error) {
    failures.push(error);
  } finally {
    for (const worker of children) {
      try {
        if (worker.child.exitCode === null && worker.child.signalCode === null)
          worker.child.kill('SIGKILL');
        await bounded(worker.closed);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const close of [
      async () => {
        if (module) await module.close();
      },
      async () => events.close(),
      async () => {
        if (
          queue.opts.prefix !== prefix ||
          !/^mw-crash-test-[a-f0-9-]{36}$/.test(prefix)
        )
          throw new Error('Queue ownership mismatch');
        await queue.obliterate({ force: true });
        expect(await inventory.keys(`${prefix}:*`)).toEqual([]);
        expect(await inventory.get(sentinel)).toBe('synthetic-untouched');
        await inventory.del(sentinel);
      },
      async () => queue.close(),
      () => inventory.disconnect(),
    ]) {
      try {
        await bounded(Promise.resolve(close()));
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length)
    throw new AggregateError(failures, 'Worker crash verification failed', {
      cause: failures[0],
    });
}

describe('Worker active-job crash recovery (real process/Nest/Redis)', () => {
  let consoleSpy: jest.SpyInstance;
  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => consoleSpy.mockRestore());

  it('cleans up a live owned Worker and queue when verification fails', async () => {
    const failure = new Error('Synthetic verification failure');
    let owned: HoldingProcess | undefined;
    let ownedPrefix: string | undefined;
    await expect(
      withCrashFixture(async ({ queue, hold, prefix }) => {
        ownedPrefix = prefix;
        owned = await hold();
        const job = await queue.add(SYSTEM_JOB_NAMES.SMOKE_TEST, {
          message: 'synthetic-cleanup',
          sentAt: new Date().toISOString(),
        });
        await until(() =>
          owned!.messages.some(
            (m) => m.type === 'entered' && m.jobId === job.id,
          ),
        );
        expect(await job.getState()).toBe('active');
        throw failure;
      }),
    ).rejects.toMatchObject({ cause: failure, errors: [failure] });
    expect(owned).toBeDefined();
    expect(
      owned!.child.exitCode !== null || owned!.child.signalCode !== null,
    ).toBe(true);
    expect(ownedPrefix).toMatch(/^mw-crash-test-[a-f0-9-]{36}$/);
    const probe = new Redis({
      host: '127.0.0.1',
      port: Number(process.env.MEETWISE_RESET_TEST_REDIS_PORT),
      connectTimeout: 1000,
      retryStrategy: () => null,
      maxRetriesPerRequest: 1,
    });
    try {
      expect(await bounded(probe.keys(ownedPrefix! + ':*'))).toEqual([]);
    } finally {
      probe.disconnect();
    }
  }, 30000);

  it('redelivers the same active job after an abrupt owned Worker crash', async () => {
    await withCrashFixture(
      async ({ queue, events, hold, crash, recover, stalled }) => {
        const worker = await hold();
        const job = await queue.add(SYSTEM_JOB_NAMES.SMOKE_TEST, {
          message: 'synthetic-crash',
          sentAt: new Date().toISOString(),
        });
        await crash(worker, job);
        await recover();
        await job.waitUntilFinished(events, 6000);
        expect(await job.getState()).toBe('completed');
        expect(stalled).toContain(job.id);
        const stored = await Job.fromId(queue, job.id!);
        expect(stored?.attemptsStarted).toBe(2);
        expect((await queue.getJobCounts('completed')).completed).toBe(1);
        expect(consoleSpy).toHaveBeenCalledTimes(1);
      },
    );
  }, 30000);

  it('fails visibly after two real crashes exceed the test stall budget', async () => {
    await withCrashFixture(async ({ queue, events, hold, crash, recover }) => {
      const first = await hold();
      const job = await queue.add(SYSTEM_JOB_NAMES.SMOKE_TEST, {
        message: 'synthetic-poison',
        sentAt: new Date().toISOString(),
      });
      await crash(first, job);
      const second = await hold();
      await crash(second, job);
      await recover();
      await expect(job.waitUntilFinished(events, 6000)).rejects.toThrow(
        'job stalled more than allowable limit',
      );
      const stored = await Job.fromId(queue, job.id!);
      expect(await stored?.getState()).toBe('failed');

      expect(stored?.attemptsStarted).toBe(3);
      expect(first.messages.filter((m) => m.type === 'entered')).toHaveLength(
        1,
      );
      expect(second.messages.filter((m) => m.type === 'entered')).toHaveLength(
        1,
      );
      expect((await queue.getJobCounts('completed')).completed).toBe(0);
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  }, 30000);
});
