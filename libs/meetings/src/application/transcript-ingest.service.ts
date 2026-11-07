import {
  TranscriptIngestPolicy,
  type TranscriptIngestDecision,
  type TranscriptCommand,
} from '../domain/transcript-ingest.policy';
import type {
  ApplyTranscriptIngestRequest,
  TranscriptIngestFacts,
  TranscriptIngestRepository,
  TranscriptState,
} from './transcript-ingest.repository';

export type {
  SegmentDedupeKey,
  TranscriptIngestContext,
  TranscriptIngestFacts,
  TranscriptIngestRepository,
  TranscriptSegmentDraft,
  TranscriptState,
} from './transcript-ingest.repository';

export type TranscriptIngestCommandName = TranscriptCommand;

export type TranscriptIngestEvent =
  | { readonly kind: 'SEGMENT'; readonly segment: TranscriptSegmentObservation }
  | { readonly kind: 'CAPTURE_INTERRUPTED' }
  | { readonly kind: 'PROVIDER_COMPLETION' }
  | { readonly kind: 'MALFORMED_SEGMENT' }
  | { readonly kind: 'INGEST_HARD_FAILURE' }
  | { readonly kind: 'PROVIDER_CONTRADICTORY_FAILURE' };

export interface TranscriptSegmentObservation {
  readonly ordinal: number;
  readonly providerSegmentId: string | undefined;
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerExternalId: string | undefined;
  readonly speakerText: string | undefined;

  readonly textEncryptedRef: string;
  readonly contentHash: string;
}

export interface TranscriptIngestQuery {
  readonly meetingId: string;
  readonly botSessionId: string;

  readonly eventId: string;

  readonly expectedRevision: number;
  readonly event: TranscriptIngestEvent;
}

type TranscriptIngestOutcomeDecision = Extract<
  TranscriptIngestDecision,
  { ok: true }
>;
type TranscriptPolicyFailureReason = Extract<
  TranscriptIngestDecision,
  { ok: false }
>['reason'];

export type TranscriptServiceFailureReason =
  | 'TRANSCRIPT_FACTS_REQUIRED'
  | 'MEETING_NOT_FOUND'
  | 'SESSION_NOT_BOUND'
  | 'SESSION_MISMATCH'
  | 'STALE_EVENT'
  | 'SEGMENT_TARGET_UNAVAILABLE'
  | TranscriptPolicyFailureReason;

export type TranscriptIngestServiceFailure = Readonly<{
  ok: false;
  reason: TranscriptServiceFailureReason;
}>;

export interface TranscriptIngestServiceOutcome {
  readonly auditRecorded: boolean;
  readonly revisionReadyRecorded: boolean;
  readonly ok: true;

  readonly k: 'APPLIED' | 'RECORDED_ONLY' | 'ALREADY_PROCESSED';
  readonly command: TranscriptIngestCommandName;
  readonly from: TranscriptState;
  readonly to: TranscriptState;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly transcriptId: string | undefined;

  readonly metadataQuarantined?: boolean;
  readonly ignoredDuplicate?: boolean;
  readonly revisionBumped?: boolean;

  readonly invalidateUnpublishedAnalysis?: boolean;
  readonly appendedAuditEventOnly?: boolean;

  readonly segmentRecordId?: string;
  readonly receiptRecorded: boolean;
}

export class TranscriptIngestService {
  private readonly policy: TranscriptIngestPolicy;
  private readonly repository: TranscriptIngestRepository;

  constructor(
    repository: TranscriptIngestRepository,
    policy?: TranscriptIngestPolicy,
  ) {
    this.repository = repository;
    this.policy = policy ?? new TranscriptIngestPolicy();
  }

  async ingest(
    query: TranscriptIngestQuery | null,
  ): Promise<TranscriptIngestServiceOutcome | TranscriptIngestServiceFailure> {
    if (!this.isWellFormedQuery(query)) {
      return failure('TRANSCRIPT_FACTS_REQUIRED');
    }
    const q = query;

    const facts: TranscriptIngestFacts = await this.repository.getIngestFacts({
      meetingId: q.meetingId,
      botSessionId: q.botSessionId,
      eventId: q.eventId,
    });
    if (!facts.meetingExists) {
      return failure('MEETING_NOT_FOUND');
    }
    if (facts.sessionMeetingId !== q.meetingId) {
      return failure('SESSION_NOT_BOUND');
    }
    const committedRevision = facts.head !== null ? facts.head.revision : 0;
    if (facts.head !== null && facts.head.state === 'NONE') {
      throw new Error(
        'transcript-ingest: non-compliant NONE head row (repository contract violation)',
      );
    }
    if (facts.eventAlreadyProcessed) {
      return this.buildAlreadyProcessed(q.event, facts.head);
    }
    if (facts.head !== null && facts.head.botSessionId !== q.botSessionId) {
      return failure('SESSION_MISMATCH');
    }
    if (q.expectedRevision !== committedRevision) {
      return failure('STALE_EVENT');
    }

    const command = commandFromEventKind(q.event);
    const from = facts.head !== null ? facts.head.state : ('NONE' as const);
    let effectiveCommand: TranscriptIngestCommandName = command;
    let duplicateVerdict = false;
    let metadataQuarantined = false;
    const segment = q.event.kind === 'SEGMENT' ? q.event.segment : undefined;

    if (command === 'INGEST_SEGMENT') {
      if (!this.isWellFormedSegment(segment)) {
        effectiveCommand = 'QUARANTINE_MALFORMED';
        metadataQuarantined = true;
      } else {
        duplicateVerdict = await this.repository.isSegmentDuplicate({
          botSessionId: q.botSessionId,
          providerSegmentId: segment.providerSegmentId,
          ordinal: segment.ordinal,
          contentHash: segment.contentHash,
        });
        if (duplicateVerdict && facts.head === null) {
          return failure('SEGMENT_TARGET_UNAVAILABLE');
        }
      }
    }

    const decision: TranscriptIngestDecision = this.policy.evaluate({
      command: effectiveCommand,
      currentState: from,
      duplicate: duplicateVerdict,
    });
    if (decision.ok !== true) {
      return decision;
    }
    return this.buildPersistedOutcome(decision, {
      q,
      committedRevision,
      head: facts.head,
      duplicateVerdict,
      metadataQuarantined,
      segment: metadataQuarantined ? undefined : segment,
    });
  }

  private buildAlreadyProcessed(
    event: TranscriptIngestEvent,
    head: TranscriptIngestFacts['head'],
  ): TranscriptIngestServiceOutcome {
    const state = head !== null ? head.state : ('NONE' as const);
    const revision = head !== null ? head.revision : 0;
    return Object.freeze({
      ok: true as const,
      k: 'ALREADY_PROCESSED' as const,
      command: commandFromEventKind(event),
      from: state,
      to: state,
      revisionBefore: revision,
      revisionAfter: revision,
      transcriptId: head !== null ? head.id : undefined,
      receiptRecorded: false,
      auditRecorded: false,
      revisionReadyRecorded: false,
    });
  }

  private async buildPersistedOutcome(
    decision: TranscriptIngestOutcomeDecision,
    context: {
      q: TranscriptIngestQuery;
      committedRevision: number;
      head: TranscriptIngestFacts['head'];
      duplicateVerdict: boolean;
      metadataQuarantined: boolean;
      segment: TranscriptSegmentObservation | undefined;
    },
  ): Promise<TranscriptIngestServiceOutcome> {
    const { q, committedRevision, head, duplicateVerdict } = context;

    const receiptOnly =
      (decision.command === 'INGEST_SEGMENT' && decision.ignoredDuplicate) ||
      (decision.command === 'COMPLETE_TRANSACTION' &&
        decision.from === 'COMPLETE') ||
      decision.command === 'OBSERVE_CONTRADICTORY_FAILURE';
    const createHead = !receiptOnly && head === null;
    const targetRevision = receiptOnly
      ? committedRevision
      : decision.revisionBumped
        ? committedRevision + 1
        : createHead
          ? 1
          : committedRevision;
    const request: ApplyTranscriptIngestRequest = {
      command: decision.command,
      announceRevisionReady:
        !receiptOnly &&
        (decision.to === 'PARTIAL' || decision.to === 'COMPLETE') &&
        (decision.from !== decision.to || targetRevision !== committedRevision),
      meetingId: q.meetingId,
      botSessionId: q.botSessionId,
      eventId: q.eventId,
      expectedRevision: committedRevision,
      createHead,
      expectedState: decision.from,
      targetState: decision.to,
      targetRevision,
      segment:
        !receiptOnly && !duplicateVerdict && context.segment !== undefined
          ? {
              ordinal: context.segment.ordinal,
              providerSegmentId: context.segment.providerSegmentId,
              startMs: context.segment.startMs,
              endMs: context.segment.endMs,
              speakerExternalId: context.segment.speakerExternalId,
              speakerText: context.segment.speakerText,
              textEncryptedRef: context.segment.textEncryptedRef,
              contentHash: context.segment.contentHash,
            }
          : undefined,
      receiptOnly,
    };
    const applied = await this.repository.applyIngest(request);
    if (applied.auditRecorded !== true)
      throw new Error('transcript-ingest: audit evidence was not persisted');
    if (applied.revisionReadyRecorded !== request.announceRevisionReady)
      throw new Error(
        'transcript-ingest: readiness intent persistence mismatch',
      );
    const expectedSessionId =
      head === null ? q.botSessionId : head.botSessionId;
    if (
      !applied.head ||
      typeof applied.head.id !== 'string' ||
      applied.head.id.trim() === '' ||
      applied.head.meetingId !== q.meetingId ||
      applied.head.botSessionId !== expectedSessionId ||
      applied.head.state !== request.targetState ||
      applied.head.revision !== request.targetRevision ||
      (head !== null && !decision.revisionBumped && applied.head.id !== head.id)
    ) {
      throw new Error('transcript-ingest: persisted head binding mismatch');
    }
    return Object.freeze({
      ok: true as const,
      k: receiptOnly ? 'RECORDED_ONLY' : 'APPLIED',
      command: decision.command,
      from: decision.from,
      to: decision.to,
      revisionBefore: committedRevision,
      revisionAfter: applied.head.revision,
      transcriptId: applied.head.id,
      revisionBumped: decision.revisionBumped,
      invalidateUnpublishedAnalysis: decision.invalidateUnpublishedAnalysis,
      appendedAuditEventOnly: decision.appendedAuditEventOnly,
      ignoredDuplicate: decision.ignoredDuplicate,
      ...(context.metadataQuarantined
        ? { metadataQuarantined: true as const }
        : {}),
      ...(applied.segmentRecordId !== undefined
        ? { segmentRecordId: applied.segmentRecordId }
        : {}),
      receiptRecorded: true,
      auditRecorded: applied.auditRecorded,
      revisionReadyRecorded: applied.revisionReadyRecorded,
    });
  }

  private isWellFormedQuery(query: unknown): query is TranscriptIngestQuery {
    if (query === null || typeof query !== 'object') {
      return false;
    }
    const q = query as Record<string, unknown>;
    for (const field of ['meetingId', 'botSessionId', 'eventId']) {
      const value = q[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return false;
      }
    }
    if (
      !Number.isSafeInteger(q.expectedRevision) ||
      (q.expectedRevision as number) < 0
    ) {
      return false;
    }
    const event = q.event;
    if (event === null || typeof event !== 'object') {
      return false;
    }
    const kind = (event as Record<string, unknown>)['kind'];
    if (
      kind !== 'SEGMENT' &&
      kind !== 'CAPTURE_INTERRUPTED' &&
      kind !== 'PROVIDER_COMPLETION' &&
      kind !== 'MALFORMED_SEGMENT' &&
      kind !== 'INGEST_HARD_FAILURE' &&
      kind !== 'PROVIDER_CONTRADICTORY_FAILURE'
    ) {
      return false;
    }

    if (kind === 'SEGMENT') {
      const seg = (event as Record<string, unknown>)['segment'];
      if (seg === null || typeof seg !== 'object') {
        return false;
      }
    }
    return true;
  }

  private isWellFormedSegment(
    observation: TranscriptSegmentObservation | null | undefined,
  ): observation is TranscriptSegmentObservation {
    if (observation === null || typeof observation !== 'object') {
      return false;
    }
    const obs = observation as unknown as Record<string, unknown>;
    if (
      !Number.isSafeInteger(obs['ordinal']) ||
      (obs['ordinal'] as number) < 0 ||
      !Number.isSafeInteger(obs['startMs']) ||
      (obs['startMs'] as number) < 0 ||
      !Number.isSafeInteger(obs['endMs']) ||
      (obs['endMs'] as number) < 0 ||
      (obs['startMs'] as number) > (obs['endMs'] as number)
    ) {
      return false;
    }
    for (const field of ['textEncryptedRef', 'contentHash']) {
      const value = obs[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return false;
      }
    }
    for (const field of ['providerSegmentId', 'speakerExternalId']) {
      const value = obs[field];
      if (
        value !== undefined &&
        (typeof value !== 'string' || value.trim() === '')
      ) {
        return false;
      }
    }
    const speakerText = obs['speakerText'];
    if (speakerText !== undefined && typeof speakerText !== 'string') {
      return false;
    }
    return true;
  }
}

function failure(
  reason: TranscriptServiceFailureReason,
): TranscriptIngestServiceFailure {
  return Object.freeze({ ok: false as const, reason });
}

function commandFromEventKind(
  event: TranscriptIngestEvent,
): TranscriptIngestCommandName {
  switch (event.kind) {
    case 'SEGMENT':
      return 'INGEST_SEGMENT';
    case 'CAPTURE_INTERRUPTED':
      return 'MARK_PARTIAL';
    case 'PROVIDER_COMPLETION':
      return 'COMPLETE_TRANSACTION';
    case 'MALFORMED_SEGMENT':
      return 'QUARANTINE_MALFORMED';
    case 'INGEST_HARD_FAILURE':
      return 'MARK_INGEST_FAILED';
    case 'PROVIDER_CONTRADICTORY_FAILURE':
      return 'OBSERVE_CONTRADICTORY_FAILURE';
  }
}
