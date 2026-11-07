import { randomUUID } from 'node:crypto';
const RESET_ACCOUNT = { userId: randomUUID(), tokenVersion: 0 };
import { getQueueToken } from '@nestjs/bullmq';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JobsOptions } from 'bullmq';
import { AUTH_JOB_NAMES, QUEUE_NAMES } from './queue.constants';
import { QueueProducerService } from './queue-producer.service';
import { SendPasswordResetEmailJobData } from './queue.types';
const SAFE_FAILURE_LOG_MESSAGE = 'Failed to enqueue password reset email job';
const GENERIC_UNAVAILABLE_MESSAGE =
  'Password reset request service is temporarily unavailable';
const SYNTHETIC_FAILURE_SENTINEL = 'SYNTHETIC-QUEUE-FAILURE-SENTINEL';
const SYNTHETIC_SECRET_LIKE_VALUE = 'synthetic-secret-like-value';
const SYNTHETIC_RECIPIENT = 'recipient@example.invalid';
type QueueAddArguments = [
  name: string,
  data: SendPasswordResetEmailJobData,
  options: JobsOptions,
];
function spyOnLoggerError(logSink: unknown[][]) {
  return jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation((...args: unknown[]) => {
      logSink.push(args);
    });
}
async function captureFailure(
  operation: () => Promise<void>,
): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}
function statusOf(error: unknown): number | undefined {
  return error instanceof ServiceUnavailableException
    ? error.getStatus()
    : undefined;
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
describe('QueueProducerService', () => {
  let module: TestingModule;
  let service: QueueProducerService;
  let queueAdd: jest.Mock<Promise<unknown>, QueueAddArguments>;
  let loggerErrorSpy: ReturnType<typeof spyOnLoggerError>;
  let loggedArguments: unknown[][];
  beforeEach(async () => {
    queueAdd = jest.fn<Promise<unknown>, QueueAddArguments>();
    queueAdd.mockResolvedValue(undefined);
    loggedArguments = [];
    module = await Test.createTestingModule({
      providers: [
        QueueProducerService,
        {
          provide: getQueueToken(QUEUE_NAMES.AUTH),
          useValue: { add: queueAdd },
        },
      ],
    }).compile();
    service = module.get(QueueProducerService);
    loggerErrorSpy = spyOnLoggerError(loggedArguments);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await module.close();
  });
  it('enqueues the password reset job for the normalized recipient email', async () => {
    await service.enqueuePasswordResetEmail(
      '  Recipient@Example.Invalid  ',
      RESET_ACCOUNT,
    );
    expect(queueAdd).toHaveBeenCalledTimes(1);
    const [jobName, jobData] = queueAdd.mock.calls[0];
    expect(jobName).toBe(AUTH_JOB_NAMES.SEND_PASSWORD_RESET_EMAIL);
    expect(jobData.email).toBe('recipient@example.invalid');
    expect(loggedArguments).toEqual([]);
  });
  it('gives every enqueue its own request identity without embedding the recipient', async () => {
    const beforeEnqueue = Date.now();
    await service.enqueuePasswordResetEmail(
      'first@example.invalid',
      RESET_ACCOUNT,
    );
    const afterEnqueue = Date.now();
    await service.enqueuePasswordResetEmail(
      'second@example.invalid',
      RESET_ACCOUNT,
    );
    expect(queueAdd).toHaveBeenCalledTimes(2);
    const [, firstJobData] = queueAdd.mock.calls[0];
    const [, secondJobData] = queueAdd.mock.calls[1];
    expect(firstJobData.requestId.length).toBeGreaterThan(0);
    expect(firstJobData.requestId).not.toBe(secondJobData.requestId);
    expect(firstJobData.requestId).not.toContain('first@example.invalid');
    expect(secondJobData.requestId).not.toContain('second@example.invalid');
    expect(firstJobData.requestTimestamp).toBeGreaterThanOrEqual(beforeEnqueue);
    expect(firstJobData.requestTimestamp).toBeLessThanOrEqual(afterEnqueue);
  });
  it('keeps one deduplication identity for equivalent normalized recipients', async () => {
    await service.enqueuePasswordResetEmail(
      '  Duplicate@Example.Invalid ',
      RESET_ACCOUNT,
    );
    await service.enqueuePasswordResetEmail(
      'duplicate@example.invalid',
      RESET_ACCOUNT,
    );
    const [, firstJobData, firstOptions] = queueAdd.mock.calls[0];
    const [, secondJobData, secondOptions] = queueAdd.mock.calls[1];
    const firstDeduplicationId = firstOptions.deduplication?.id;
    const secondDeduplicationId = secondOptions.deduplication?.id;
    expect(firstJobData.email).toBe(secondJobData.email);
    expect(firstDeduplicationId).toBeDefined();
    expect(firstDeduplicationId).not.toBe('');
    expect(firstDeduplicationId).toBe(secondDeduplicationId);
    expect(firstDeduplicationId).not.toContain('duplicate@example.invalid');
  });
  it('derives a different deduplication identity for a different recipient', async () => {
    await service.enqueuePasswordResetEmail(
      'alpha@example.invalid',
      RESET_ACCOUNT,
    );
    await service.enqueuePasswordResetEmail(
      'beta@example.invalid',
      RESET_ACCOUNT,
    );
    const [, , firstOptions] = queueAdd.mock.calls[0];
    const [, , secondOptions] = queueAdd.mock.calls[1];
    const firstDeduplicationId = firstOptions.deduplication?.id;
    const secondDeduplicationId = secondOptions.deduplication?.id;
    expect(firstDeduplicationId).toBeDefined();
    expect(secondDeduplicationId).toBeDefined();
    expect(firstDeduplicationId).not.toBe(secondDeduplicationId);
  });
  it('maps a rejected enqueue to a generic 503 without logging the raw error text', async () => {
    const rawFailure = new Error(
      `queue refused: ${SYNTHETIC_FAILURE_SENTINEL}\nINFO forged entry for ${SYNTHETIC_RECIPIENT}`,
    );
    queueAdd.mockRejectedValue(rawFailure);
    const failure = await captureFailure(() =>
      service.enqueuePasswordResetEmail(SYNTHETIC_RECIPIENT, RESET_ACCOUNT),
    );
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect(statusOf(failure)).toBe(503);
    expect(messageOf(failure)).toBe(GENERIC_UNAVAILABLE_MESSAGE);
    expect(messageOf(failure)).not.toContain(SYNTHETIC_FAILURE_SENTINEL);
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    expect(loggedArguments).toEqual([[SAFE_FAILURE_LOG_MESSAGE]]);
    const loggedText = loggedArguments.flat().join('\n');
    expect(loggedText).not.toContain(SYNTHETIC_FAILURE_SENTINEL);
    expect(loggedText).not.toContain(SYNTHETIC_RECIPIENT);
    expect(loggedText).not.toContain('\n');
  });
  it.each<unknown>([
    `queue unavailable: ${SYNTHETIC_FAILURE_SENTINEL}`,
    {
      message: SYNTHETIC_FAILURE_SENTINEL,
      detail: { apiKey: SYNTHETIC_SECRET_LIKE_VALUE },
    },
    null,
    undefined,
  ])(
    'maps an unexpected queue rejection (%p) to the same generic 503',
    async (rejection) => {
      queueAdd.mockRejectedValue(rejection);
      const failure = await captureFailure(() =>
        service.enqueuePasswordResetEmail(SYNTHETIC_RECIPIENT, RESET_ACCOUNT),
      );
      expect(failure).toBeInstanceOf(ServiceUnavailableException);
      expect(statusOf(failure)).toBe(503);
      expect(messageOf(failure)).not.toContain(SYNTHETIC_FAILURE_SENTINEL);
      expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
      expect(loggedArguments).toEqual([[SAFE_FAILURE_LOG_MESSAGE]]);
      const loggedText = loggedArguments.flat().join('\n');
      expect(loggedText).not.toContain(SYNTHETIC_FAILURE_SENTINEL);
      expect(loggedText).not.toContain(SYNTHETIC_SECRET_LIKE_VALUE);
    },
  );
  it('never reads the rejection message while still mapping the failure to a generic 503', async () => {
    let messageGetterAccessed = false;
    const hostileFailure = new Error('synthetic queue failure');
    Object.defineProperty(hostileFailure, 'message', {
      configurable: true,
      get: () => {
        messageGetterAccessed = true;
        throw new Error('the rejection message must never be read');
      },
    });
    queueAdd.mockRejectedValue(hostileFailure);
    const failure = await captureFailure(() =>
      service.enqueuePasswordResetEmail(SYNTHETIC_RECIPIENT, RESET_ACCOUNT),
    );
    expect(messageGetterAccessed).toBe(false);
    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect(statusOf(failure)).toBe(503);
    expect(messageOf(failure)).toBe(GENERIC_UNAVAILABLE_MESSAGE);
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    expect(loggedArguments).toEqual([[SAFE_FAILURE_LOG_MESSAGE]]);
  });
  it('captures immutable server-derived account metadata in the queued request', async () => {
    const identity = { ...RESET_ACCOUNT };
    await service.enqueuePasswordResetEmail(SYNTHETIC_RECIPIENT, identity);
    identity.tokenVersion++;
    expect(queueAdd.mock.calls[0][1]).toMatchObject(RESET_ACCOUNT);
  });
  it('rejects malformed account identity before queue I/O', async () => {
    await expect(
      service.enqueuePasswordResetEmail(SYNTHETIC_RECIPIENT, {
        userId: 'bad',
        tokenVersion: 0,
      }),
    ).rejects.toThrow();
    expect(queueAdd).not.toHaveBeenCalled();
  });
});
