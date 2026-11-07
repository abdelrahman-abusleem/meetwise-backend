import type { TranscriptCommand } from '../domain/transcript-ingest.policy';

export type TranscriptState =
  'NONE' | 'RECEIVING' | 'PARTIAL' | 'COMPLETE' | 'INVALID' | 'FAILED';

export interface TranscriptHeadRecord {
  readonly id: string;
  readonly meetingId: string;

  readonly botSessionId: string;
  readonly revision: number;
  readonly state: TranscriptState;
  readonly isPartial: boolean;
}

export interface TranscriptIngestFacts {
  readonly meetingExists: boolean;

  readonly sessionMeetingId: string | null;

  readonly head: TranscriptHeadRecord | null;

  readonly eventAlreadyProcessed: boolean;
}

export interface TranscriptSegmentDraft {
  readonly ordinal: number;
  readonly providerSegmentId: string | undefined;
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerExternalId: string | undefined;
  readonly speakerText: string | undefined;

  readonly textEncryptedRef: string;
  readonly contentHash: string;
}

export interface SegmentDedupeKey {
  readonly botSessionId: string;

  readonly providerSegmentId: string | undefined;

  readonly ordinal: number;
  readonly contentHash: string;
}

export interface ApplyTranscriptIngestRequest {
  readonly command: TranscriptCommand;

  readonly announceRevisionReady: boolean;
  readonly meetingId: string;
  readonly botSessionId: string;

  readonly eventId: string;

  readonly expectedRevision: number;

  readonly expectedState: TranscriptState;
  readonly createHead: boolean;
  readonly targetState: TranscriptState;
  readonly targetRevision: number;

  readonly segment: TranscriptSegmentDraft | undefined;

  readonly receiptOnly: boolean;
}

export interface ApplyTranscriptIngestResult {
  readonly auditRecorded: boolean;
  readonly revisionReadyRecorded: boolean;
  readonly head: TranscriptHeadRecord;

  readonly segmentRecordId: string | undefined;
}

export interface TranscriptIngestContext {
  readonly meetingId: string;

  readonly botSessionId: string;

  readonly eventId: string;
}

export interface TranscriptIngestRepository {
  getIngestFacts(
    context: TranscriptIngestContext,
  ): Promise<TranscriptIngestFacts>;

  isSegmentDuplicate(key: SegmentDedupeKey): Promise<boolean>;

  applyIngest(
    request: ApplyTranscriptIngestRequest,
  ): Promise<ApplyTranscriptIngestResult>;
}
