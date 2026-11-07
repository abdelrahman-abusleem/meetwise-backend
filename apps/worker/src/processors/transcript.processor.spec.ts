import { Job, Queue } from 'bullmq';
import { PrismaService } from '@meetwise/infrastructure/database';
import { TranscriptEnvelope } from '../../../../libs/meetings/src/infrastructure/transcript-envelope';
import { PostgresTranscriptConsumer } from '../../../../libs/meetings/src/infrastructure/transcript-ingest.postgres';
import { TranscriptProcessor } from './transcript.processor';
import { TranscriptDispatcher } from './transcript-dispatcher';

describe('Transcript worker boundary (unit, not Redis/PG evidence)', () => {
  const database = {} as PrismaService;
  const envelope = new TranscriptEnvelope({
    activeVersion: () => 'unconfigured',
    keyFor: () => undefined,
  });
  const consumer = new PostgresTranscriptConsumer(database, envelope);
  const processor = new TranscriptProcessor(consumer);
  afterEach(() => jest.restoreAllMocks());
  it.each([
    null,
    [],
    {},
    { eventId: 42 },
    { eventId: 'synthetic', text: 'private marker' },
  ])('rejects malformed or content-bearing jobs %j', async (data) => {
    const consume = jest.spyOn(consumer, 'consume');
    await expect(
      processor.process({ name: 'ingest-inbox.v1', data } as Job<unknown>),
    ).rejects.toThrow('Transcript job invalid');
    expect(consume).not.toHaveBeenCalled();
  });
  it('rejects unknown task names before invoking the database', async () => {
    const consume = jest.spyOn(consumer, 'consume');
    await expect(
      processor.process({
        name: 'unknown',
        data: { eventId: 'synthetic' },
      } as Job<unknown>),
    ).rejects.toThrow('Transcript job invalid');
    expect(consume).not.toHaveBeenCalled();
  });
  it('sanitizes arbitrary downstream exceptions before Redis can record failure reasons', async () => {
    jest.spyOn(consumer, 'consume').mockRejectedValue({
      message: 'private marker',
      toString: () => {
        throw new Error('must not inspect');
      },
    });
    await expect(
      processor.process({
        name: 'ingest-inbox.v1',
        data: { eventId: 'synthetic' },
      } as Job<unknown>),
    ).rejects.toEqual(new Error('Transcript ingestion failed'));
  });
  it('discards downstream return values', async () => {
    jest.spyOn(consumer, 'consume').mockResolvedValue({
      ok: true,
      k: 'ALREADY_PROCESSED',
      command: 'INGEST_SEGMENT',
      from: 'COMPLETE',
      to: 'COMPLETE',
      revisionBefore: 1,
      revisionAfter: 1,
      transcriptId: 'synthetic',
      receiptRecorded: false,
      auditRecorded: false,
      revisionReadyRecorded: false,
    });
    await expect(
      processor.process({
        name: 'ingest-inbox.v1',
        data: { eventId: 'synthetic' },
      } as Job<unknown>),
    ).resolves.toBeUndefined();
  });
});

describe('Transcript durable wake-up dispatch (unit)', () => {
  it('uses ID-only jobs and progresses past an exhausted poison page', async () => {
    const first = { id: 'synthetic-a', createdAt: new Date(10) },
      second = { id: 'synthetic-b', createdAt: new Date(20) };
    const query = jest
      .fn<Promise<{ id: string; createdAt: Date }[]>, unknown[]>()
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([second])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([first]);
    const add = jest
      .fn<
        Promise<void>,
        [string, { eventId: string }, Record<string, unknown>]
      >()
      .mockResolvedValue(undefined);
    const dispatcher = new TranscriptDispatcher(
      { $queryRaw: query } as unknown as PrismaService,
      { add } as unknown as Queue,
    );
    expect(await dispatcher.dispatchPending()).toBe(1);
    expect(await dispatcher.dispatchPending()).toBe(1);
    expect(await dispatcher.dispatchPending()).toBe(0);
    expect(await dispatcher.dispatchPending()).toBe(1);
    expect(query.mock.calls[1]).toContain(first.createdAt);
    expect(add.mock.calls.map((call) => call[1])).toEqual([
      { eventId: first.id },
      { eventId: second.id },
      { eventId: first.id },
    ]);
    expect(add.mock.calls[0][2]).toMatchObject({
      attempts: 3,
      removeOnFail: false,
      backoff: { type: 'exponential', jitter: 0.5 },
    });
  });
  it('leaves a failed dispatch page retryable after Redis unavailability', async () => {
    const row = { id: 'synthetic-a', createdAt: new Date(10) };
    const query = jest
      .fn<Promise<{ id: string; createdAt: Date }[]>, unknown[]>()
      .mockResolvedValue([row]);
    const add = jest
      .fn<
        Promise<void>,
        [string, { eventId: string }, Record<string, unknown>]
      >()
      .mockRejectedValueOnce(new Error('synthetic Redis unavailable'))
      .mockResolvedValue(undefined);
    const dispatcher = new TranscriptDispatcher(
      { $queryRaw: query } as unknown as PrismaService,
      { add } as unknown as Queue,
    );
    await expect(dispatcher.dispatchPending()).rejects.toThrow(
      'synthetic Redis unavailable',
    );
    expect(await dispatcher.dispatchPending()).toBe(1);
    expect(query.mock.calls[0].slice(1)).toEqual(query.mock.calls[1].slice(1));
  });
});
