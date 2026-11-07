type TranscriptState =
  'NONE' | 'RECEIVING' | 'PARTIAL' | 'COMPLETE' | 'INVALID' | 'FAILED';

export type TranscriptCommand =
  | 'INGEST_SEGMENT'
  | 'MARK_PARTIAL'
  | 'COMPLETE_TRANSACTION'
  | 'QUARANTINE_MALFORMED'
  | 'MARK_INGEST_FAILED'
  | 'OBSERVE_CONTRADICTORY_FAILURE';

export interface TranscriptIngestRequest {
  readonly command: string;
  readonly currentState: string;

  readonly duplicate: boolean;
}

export interface TranscriptIngestOutcome {
  readonly ok: true;
  readonly command: TranscriptCommand;
  readonly from: TranscriptState;
  readonly to: TranscriptState;

  readonly ignoredDuplicate: boolean;
  readonly revisionBumped: boolean;

  readonly invalidateUnpublishedAnalysis: boolean;

  readonly appendedAuditEventOnly: boolean;
}

export type TranscriptIngestDecision =
  TranscriptIngestOutcome | Readonly<{ ok: false; reason: TranscriptFailure }>;

type TranscriptFailure =
  | 'INVALID_COMMAND'
  | 'UNKNOWN_STATE'
  | 'SEGMENT_FACTS_REQUIRED'
  | 'INGEST_BLOCKED'
  | 'COMPLETION_NOT_ALLOWED'
  | 'MARK_PARTIAL_NOT_ALLOWED'
  | 'INTERRUPT_NOT_ALLOWED'
  | 'QUARANTINE_NOT_APPLICABLE'
  | 'CONTRADICTION_NOT_APPLICABLE';

const TRANSCRIPT_STATES: Readonly<TranscriptState[]> = [
  'NONE',
  'RECEIVING',
  'PARTIAL',
  'COMPLETE',
  'INVALID',
  'FAILED',
];
const INGEST_COMMANDS: Readonly<TranscriptCommand[]> = [
  'INGEST_SEGMENT',
  'MARK_PARTIAL',
  'COMPLETE_TRANSACTION',
  'QUARANTINE_MALFORMED',
  'MARK_INGEST_FAILED',
  'OBSERVE_CONTRADICTORY_FAILURE',
];

export class TranscriptIngestPolicy {
  evaluate(request: TranscriptIngestRequest): TranscriptIngestDecision {
    const shapeFailure = this.requestShapeFailure(request);
    if (shapeFailure !== null) {
      return this.reject(shapeFailure);
    }
    const command = request.command as TranscriptCommand;
    const from = request.currentState as TranscriptState;

    if (command === 'OBSERVE_CONTRADICTORY_FAILURE') {
      if (from !== 'COMPLETE') {
        return this.reject('CONTRADICTION_NOT_APPLICABLE');
      }
      return this.approve(request, command, from, from, false, true);
    }

    if (command === 'INGEST_SEGMENT') {
      if (from === 'INVALID' || from === 'FAILED') {
        return this.reject('INGEST_BLOCKED');
      }

      if (request.duplicate) {
        return this.approve(request, command, from, from);
      }
      if (from === 'NONE' || from === 'RECEIVING') {
        return this.approve(request, command, from, 'RECEIVING');
      }
      return this.approve(request, command, from, from, true);
    }

    if (command === 'MARK_PARTIAL') {
      if (from === 'RECEIVING') {
        return this.approve(request, command, from, 'PARTIAL');
      }
      return this.reject(
        from === 'PARTIAL'
          ? 'INTERRUPT_NOT_ALLOWED'
          : 'MARK_PARTIAL_NOT_ALLOWED',
      );
    }

    if (command === 'COMPLETE_TRANSACTION') {
      if (from === 'RECEIVING' || from === 'PARTIAL') {
        return this.approve(request, command, from, 'COMPLETE');
      }
      if (from === 'COMPLETE') {
        return this.approve(request, command, from, 'COMPLETE', false, true);
      }
      return this.reject('COMPLETION_NOT_ALLOWED');
    }

    if (command === 'QUARANTINE_MALFORMED') {
      if (from === 'RECEIVING' || from === 'PARTIAL') {
        return this.approve(request, command, from, 'INVALID');
      }
      return this.reject(
        from === 'NONE' ? 'QUARANTINE_NOT_APPLICABLE' : 'INGEST_BLOCKED',
      );
    }

    if (from === 'NONE' || from === 'RECEIVING') {
      return this.approve(request, command, from, 'FAILED');
    }
    return this.reject('INGEST_BLOCKED');
  }

  private requestShapeFailure(
    request: TranscriptIngestRequest,
  ): TranscriptFailure | null {
    if (request === null || typeof request !== 'object') {
      return 'INVALID_COMMAND';
    }
    if (INGEST_COMMANDS.indexOf(request.command as TranscriptCommand) === -1) {
      return 'INVALID_COMMAND';
    }
    if (
      TRANSCRIPT_STATES.indexOf(request.currentState as TranscriptState) === -1
    ) {
      return 'UNKNOWN_STATE';
    }
    if (typeof request.duplicate !== 'boolean') {
      return 'SEGMENT_FACTS_REQUIRED';
    }
    return null;
  }

  private approve(
    request: TranscriptIngestRequest,
    command: TranscriptCommand,
    from: TranscriptState,
    to: TranscriptState,
    lateSegment = false,
    contradictoryEventOnly = false,
  ): TranscriptIngestOutcome {
    const duplicate = request.duplicate;
    const revisionBumped =
      lateSegment && command === 'INGEST_SEGMENT' && !duplicate;
    return Object.freeze({
      ok: true as const,
      command,
      from,
      to,
      ignoredDuplicate: duplicate && command === 'INGEST_SEGMENT',
      revisionBumped,
      invalidateUnpublishedAnalysis: revisionBumped,
      appendedAuditEventOnly: contradictoryEventOnly,
    });
  }

  private reject(reason: TranscriptFailure): TranscriptIngestDecision {
    return Object.freeze({ ok: false as const, reason });
  }
}
