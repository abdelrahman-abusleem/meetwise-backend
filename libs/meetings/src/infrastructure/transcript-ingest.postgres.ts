import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@meetwise/infrastructure/database';
import {
  TranscriptIngestService,
  type TranscriptIngestEvent,
} from '../application/transcript-ingest.service';
import type {
  ApplyTranscriptIngestRequest,
  SegmentDedupeKey,
  TranscriptHeadRecord,
  TranscriptIngestContext,
  TranscriptIngestFacts,
  TranscriptIngestRepository,
} from '../application/transcript-ingest.repository';
import type { TranscriptEnvelope } from './transcript-envelope';

export type TranscriptSqlTransaction = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | '$executeRaw'
>;
export interface TranscriptTransactionRunner {
  $transaction<T>(
    work: (transaction: TranscriptSqlTransaction) => Promise<T>,
    options: { timeout: number; maxWait: number },
  ): Promise<T>;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function validInbox(row: Inbox, eventId: string): boolean {
  return (
    row.id === eventId &&
    UUID.test(row.meetingId) &&
    UUID.test(row.botSessionId)
  );
}

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function dedupe(key: SegmentDedupeKey): string {
  return digest(
    key.providerSegmentId === undefined
      ? ['fallback', key.botSessionId, key.contentHash, key.ordinal]
      : ['provider', key.botSessionId, key.providerSegmentId],
  );
}
interface Inbox {
  id: string;
  meetingId: string;
  botSessionId: string;
  encryptedEvent: unknown;
}

export class PostgresTranscriptConsumer {
  constructor(
    private readonly database: TranscriptTransactionRunner,
    private readonly encryption: Pick<TranscriptEnvelope, 'open'>,
  ) {}

  async consume(eventId: string) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        eventId,
      )
    )
      throw new Error('Transcript inbox identifier invalid');

    return this.database.$transaction(
      async (tx) => {
        const [pointer] = await tx.$queryRaw<
          Inbox[]
        >`SELECT id, meeting_id AS "meetingId", bot_session_id AS "botSessionId", encrypted_event AS "encryptedEvent" FROM transcript_inbox WHERE id=${eventId}::uuid`;
        if (!pointer) throw new Error('Transcript inbox unavailable');
        if (!validInbox(pointer, eventId))
          throw new Error('Transcript inbox binding unavailable');
        const [meeting] = await tx.$queryRaw<
          { lifecycle: string; scheduleVersion: number }[]
        >`SELECT lifecycle, schedule_version AS "scheduleVersion" FROM meetings WHERE id=${pointer.meetingId}::uuid FOR UPDATE`;
        const [session] = await tx.$queryRaw<
          { scheduleVersion: number }[]
        >`SELECT schedule_version AS "scheduleVersion" FROM bot_sessions WHERE id=${pointer.botSessionId}::uuid AND meeting_id=${pointer.meetingId}::uuid FOR SHARE`;
        const [inbox] = await tx.$queryRaw<
          Inbox[]
        >`SELECT id, meeting_id AS "meetingId", bot_session_id AS "botSessionId", encrypted_event AS "encryptedEvent" FROM transcript_inbox WHERE id=${eventId}::uuid AND meeting_id=${pointer.meetingId}::uuid AND bot_session_id=${pointer.botSessionId}::uuid FOR UPDATE`;
        if (
          !meeting ||
          !session ||
          !inbox ||
          !validInbox(inbox, eventId) ||
          inbox.meetingId !== pointer.meetingId ||
          inbox.botSessionId !== pointer.botSessionId
        )
          throw new Error('Transcript inbox binding unavailable');

        if (
          !['IN_PROGRESS', 'ENDED'].includes(meeting.lifecycle) ||
          !Number.isSafeInteger(meeting.scheduleVersion) ||
          meeting.scheduleVersion < 0 ||
          meeting.scheduleVersion !== session.scheduleVersion
        )
          throw new Error('Transcript capture generation unavailable');
        const repository = new TransactionTranscriptRepository(tx, inbox);
        const head = await repository.loadHead();
        const event = parseEvent(
          this.encryption.open(inbox.encryptedEvent, {
            recordId: inbox.id,
            purpose: 'transcript-inbox',
            meetingId: inbox.meetingId,
            botSessionId: inbox.botSessionId,
          }),
          inbox.id,
        );
        const result = await new TranscriptIngestService(repository).ingest({
          meetingId: inbox.meetingId,
          botSessionId: inbox.botSessionId,
          eventId: inbox.id,
          expectedRevision: head?.revision ?? 0,
          event,
        });
        if (!result.ok) throw new Error('Transcript event not applicable');
        return result;
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
  }
}

class TransactionTranscriptRepository implements TranscriptIngestRepository {
  private head: TranscriptHeadRecord | null = null;
  constructor(
    private readonly tx: TranscriptSqlTransaction,
    private readonly inbox: Inbox,
  ) {}

  async loadHead(): Promise<TranscriptHeadRecord | null> {
    const rows = await this.tx.$queryRaw<
      TranscriptHeadRecord[]
    >`SELECT id, meeting_id AS "meetingId", bot_session_id AS "botSessionId", revision, state, is_partial AS "isPartial" FROM transcripts WHERE meeting_id=${this.inbox.meetingId}::uuid ORDER BY revision DESC LIMIT 1 FOR UPDATE`;
    this.head = rows[0] ?? null;
    return this.head;
  }
  async getIngestFacts(
    context: TranscriptIngestContext,
  ): Promise<TranscriptIngestFacts> {
    if (
      context.meetingId !== this.inbox.meetingId ||
      context.botSessionId !== this.inbox.botSessionId ||
      context.eventId !== this.inbox.id
    )
      throw new Error('Transcript transaction binding mismatch');
    const receipts = await this.tx.$queryRaw<
      { eventId: string }[]
    >`SELECT event_id AS "eventId" FROM transcript_inbox_receipts WHERE consumer='transcript-ingest' AND event_id=${this.inbox.id}::uuid`;
    return {
      meetingExists: true,
      sessionMeetingId: this.inbox.meetingId,
      head: this.head,
      eventAlreadyProcessed: receipts.length > 0,
    };
  }
  async isSegmentDuplicate(key: SegmentDedupeKey): Promise<boolean> {
    const rows = await this.tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM transcript_segments WHERE bot_session_id=${key.botSessionId}::uuid AND dedupe_hash=${dedupe(key)}`;
    return rows.length > 0;
  }
  async applyIngest(request: ApplyTranscriptIngestRequest) {
    if (
      request.meetingId !== this.inbox.meetingId ||
      request.botSessionId !== this.inbox.botSessionId ||
      request.eventId !== this.inbox.id ||
      request.expectedRevision !== (this.head?.revision ?? 0) ||
      request.expectedState !== (this.head?.state ?? 'NONE')
    )
      throw new Error('transcript-stale-event-conflict');
    let head = this.head;
    let segmentRecordId: string | undefined;
    if (!request.receiptOnly) {
      const newRevision =
        request.createHead || request.targetRevision !== head?.revision;
      const id = newRevision ? randomUUID() : head!.id;
      if (newRevision) {
        await this.tx
          .$executeRaw`INSERT INTO transcripts(id,meeting_id,bot_session_id,revision,state,is_partial,snapshot_hash) VALUES(${id}::uuid,${request.meetingId}::uuid,${request.botSessionId}::uuid,${request.targetRevision},${request.targetState},${request.targetState === 'PARTIAL'},${digest([])})`;
        if (head)
          await this.tx
            .$executeRaw`INSERT INTO transcript_revision_segments(transcript_id,meeting_id,segment_id,ordinal) SELECT ${id}::uuid,meeting_id,segment_id,ordinal FROM transcript_revision_segments WHERE transcript_id=${head.id}::uuid`;
      } else {
        const changed = await this.tx
          .$executeRaw`UPDATE transcripts SET state=${request.targetState},is_partial=${request.targetState === 'PARTIAL'} WHERE id=${id}::uuid AND revision=${request.expectedRevision} AND state=${request.expectedState}`;
        if (changed !== 1) throw new Error('transcript-stale-event-conflict');
      }
      if (request.segment) {
        const segment = request.segment;
        if (segment.textEncryptedRef !== this.inbox.id)
          throw new Error('Transcript content reference unavailable');
        segmentRecordId = randomUUID();

        const encryptedContentHash = digest(this.inbox.encryptedEvent);
        await this.tx
          .$executeRaw`INSERT INTO transcript_segments(id,meeting_id,bot_session_id,event_id,ordinal,start_ms,end_ms,content_hash,dedupe_hash) VALUES(${segmentRecordId}::uuid,${request.meetingId}::uuid,${request.botSessionId}::uuid,${this.inbox.id}::uuid,${segment.ordinal},${segment.startMs},${segment.endMs},${encryptedContentHash},${dedupe({ ...segment, botSessionId: request.botSessionId })})`;
        await this.tx
          .$executeRaw`INSERT INTO transcript_revision_segments(transcript_id,meeting_id,segment_id,ordinal) VALUES(${id}::uuid,${request.meetingId}::uuid,${segmentRecordId}::uuid,${segment.ordinal})`;
      }
      const members = await this.tx.$queryRaw<
        {
          id: string;
          eventId: string;
          ordinal: number;
          contentHash: string;
          startMs: bigint;
          endMs: bigint;
        }[]
      >`SELECT s.id,s.event_id AS "eventId",s.ordinal,s.content_hash AS "contentHash",s.start_ms AS "startMs",s.end_ms AS "endMs" FROM transcript_revision_segments m JOIN transcript_segments s ON s.id=m.segment_id WHERE m.transcript_id=${id}::uuid ORDER BY m.ordinal`;
      const hash = digest(
        members.map((row) => ({
          ...row,
          startMs: row.startMs.toString(),
          endMs: row.endMs.toString(),
        })),
      );
      await this.tx
        .$executeRaw`UPDATE transcripts SET snapshot_hash=${hash} WHERE id=${id}::uuid`;
      head = {
        id,
        meetingId: request.meetingId,
        botSessionId: request.botSessionId,
        revision: request.targetRevision,
        state: request.targetState,
        isPartial: request.targetState === 'PARTIAL',
      };
    }
    if (!head) throw new Error('Transcript head unavailable');
    await this.tx
      .$executeRaw`INSERT INTO transcript_processing_audit(id,event_id,command,from_state,to_state,revision_before,revision_after) VALUES(${randomUUID()}::uuid,${this.inbox.id}::uuid,${request.command},${request.expectedState},${request.targetState},${request.expectedRevision},${request.targetRevision})`;
    if (request.announceRevisionReady) {
      const payload = JSON.stringify({
        meetingId: request.meetingId,
        transcriptId: head.id,
        revision: head.revision,
      });
      await this.tx
        .$executeRaw`INSERT INTO outbox_events(id,type,aggregate_id,aggregate_version,payload) VALUES(${randomUUID()}::uuid,'transcript.revision_ready.v1',${request.meetingId}::uuid,${head.revision},${payload}::jsonb)`;
    }
    await this.tx
      .$executeRaw`INSERT INTO transcript_inbox_receipts(consumer,event_id) VALUES('transcript-ingest',${this.inbox.id}::uuid)`;
    this.head = head;
    return {
      auditRecorded: true,
      revisionReadyRecorded: request.announceRevisionReady,
      head,
      segmentRecordId,
    };
  }
}

function parseEvent(plaintext: string, eventId: string): TranscriptIngestEvent {
  let input: unknown;
  try {
    input = JSON.parse(plaintext);
  } catch {
    throw new Error('Transcript normalized event invalid');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Transcript normalized event invalid');
  const event = input as Record<string, unknown>;
  if (event.kind === 'SEGMENT') {
    const segment = event.segment;
    if (
      !segment ||
      typeof segment !== 'object' ||
      Array.isArray(segment) ||
      (segment as Record<string, unknown>).textEncryptedRef !== eventId
    )
      throw new Error('Transcript content reference unavailable');
    const hash = (segment as Record<string, unknown>).contentHash;
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
      throw new Error('Transcript content identity invalid');
    const text = (segment as Record<string, unknown>).text;
    if (typeof text !== 'string' || text.trim() === '')
      throw new Error('Transcript normalized content unavailable');
  }

  return input as TranscriptIngestEvent;
}
