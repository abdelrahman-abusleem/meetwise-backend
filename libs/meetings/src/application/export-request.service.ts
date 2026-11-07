import {
  ExportRequestPolicy,
  type ExportRequestDecision,
  type ExportRequestFailure,
} from '../domain/export-request.policy';
import type {
  ExportClaimContext,
  ExportClaimRefusal,
  ExportClaimResult,
  ExportCreateRefusal,
  ExportDownloadAccessFacts,
  ExportFormat,
  ExportJobContractView,
  ExportKind,
  ExportReadAccessFacts,
  ExportReadContext,
  ExportRequestFacts,
  ExportRequestRepository,
  ExportWorkerFacts,
  ReportExportCompletionRequest,
  ReportExportRefusal,
} from './export-request.repository';

export type {
  ExportClaimContext,
  ExportCreateOutcomeName,
  ExportDownloadAuditContext,
  ExportJobContractView,
  ExportReadContext,
  ExportRequestRepository,
  ExportSourceItem,
  ExportStatus,
} from './export-request.repository';

export type ExportServiceFailureReason =
  | 'EXPORT_FACTS_REQUIRED'
  | 'IDEMPOTENCY_KEY_MALFORMED'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'MEETING_NOT_FOUND'
  | 'EXPORT_NOT_FOUND'
  | 'EXPORT_NOT_ACCESSIBLE'
  | 'EXPORT_NOT_DOWNLOADABLE'
  | 'EXPORT_STATUS_CONFLICT'
  | 'INVALID_EXPORT_FORMAT'
  | ExportRequestFailure;

export type ExportServiceFailure = Readonly<{
  ok: false;
  reason: ExportServiceFailureReason;

  notDownloadable?: Readonly<'STATUS_NOT_READY' | 'EXPIRED'>;
}>;

export interface ExportRequestCreated {
  readonly ok: true;

  readonly k: 'QUEUED' | 'EXISTING';
  readonly job: ExportJobContractView;
  readonly kind: string;
  readonly format: string;

  readonly jobCreationIsServerDuty: true;

  readonly auditExportDecision: true;
}

export interface ExportWorkerGatePassed {
  readonly ok: true;
  readonly k: 'GATE_PASSED';
  readonly exportId: string;

  readonly meetingId: string;
  readonly kind: ExportKind;
  readonly format: ExportFormat;
}

export interface ExportClaimed {
  readonly ok: true;
  readonly k: 'CLAIMED';
  readonly exportId: string;
  readonly meetingId: string;
  readonly kind: ExportKind;
  readonly format: ExportFormat;
}

export interface ExportCompletionReported {
  readonly ok: true;
  readonly k: 'READY' | 'FAILED';
  readonly job: ExportJobContractView;
}

export interface ExportMetadataRead {
  readonly ok: true;
  readonly k: 'METADATA';
  readonly job: ExportJobContractView;
}

export interface ExportDownloadAuthorized {
  readonly ok: true;
  readonly k: 'DELIVERY_AUTHORIZED';
  readonly job: ExportJobContractView;
  readonly kind: ExportKind;
  readonly format: ExportFormat;

  readonly deliveryIsServerDuty: true;

  readonly auditRecorded: true;
}

export type ExportServiceOutcome =
  | ExportRequestCreated
  | ExportWorkerGatePassed
  | ExportClaimed
  | ExportCompletionReported
  | ExportMetadataRead
  | ExportDownloadAuthorized;

export interface ExportRequestQuery {
  readonly meetingId: string;

  readonly requesterId: string;

  readonly kind: string;

  readonly format: string;

  readonly idempotencyKey: string;
}

export interface ExportWorkerQuery {
  readonly exportId: string;
}

export interface ExportCompletionQuery {
  readonly exportId: string;

  readonly outcome: 'SUCCEEDED' | 'FAILED';
}

export interface ExportReadQuery {
  readonly exportId: string;
  readonly requesterId: string;
}

const EXPORT_KINDS: Readonly<Record<string, boolean>> = {
  SUMMARY: true,
  TRANSCRIPT: true,
  ANALYSIS: true,
};

const EXPORT_FORMATS: Readonly<Record<string, boolean>> = {
  JSON: true,
  CSV: true,
  PDF: true,
};

export class ExportRequestService {
  private readonly policy: ExportRequestPolicy;
  private readonly repository: ExportRequestRepository;

  constructor(
    repository: ExportRequestRepository,
    policy?: ExportRequestPolicy,
  ) {
    this.repository = repository;
    this.policy = policy ?? new ExportRequestPolicy();
  }

  async requestExport(
    query: ExportRequestQuery | null,
  ): Promise<ExportRequestCreated | ExportServiceFailure> {
    const gate = this.checkShapeStrings(query, [
      'meetingId',
      'requesterId',
      'kind',
      'format',
      'idempotencyKey',
    ]);
    if (gate !== null) {
      return gate;
    }
    const q = query as ExportRequestQuery;
    if (q.idempotencyKey.length > 128) {
      return this.fail('IDEMPOTENCY_KEY_MALFORMED');
    }
    if (EXPORT_KINDS[q.kind] !== true) {
      return this.fail('INVALID_EXPORT_KIND');
    }
    if (EXPORT_FORMATS[q.format] !== true) {
      return this.fail('INVALID_EXPORT_FORMAT');
    }

    const facts: ExportRequestFacts =
      await this.repository.getExportRequestFacts({
        meetingId: q.meetingId,
        requesterId: q.requesterId,
      });
    if (!facts.meetingExists) {
      return this.fail('MEETING_NOT_FOUND');
    }
    const decision: ExportRequestDecision = this.policy.evaluate({
      command: 'REQUEST_EXPORT',
      kind: q.kind,
      meetingKind: facts.meetingKind,

      surface: 'API',
      exporterAuthorized: facts.exporterAuthorized,

      idempotencyKeyProvided: true,
    });
    if (decision.ok !== true) {
      return this.fail(decision.reason);
    }
    const created = await this.repository.createExportJob({
      meetingId: q.meetingId,
      requesterId: q.requesterId,
      kind: q.kind as ExportKind,
      format: q.format as ExportFormat,
      idempotencyKey: q.idempotencyKey,
    });
    if ('refusal' in created) {
      return this.fail(this.createRefusalReason(created.refusal));
    }
    return this.freeze({
      ok: true as const,
      k: created.created ? 'QUEUED' : 'EXISTING',
      job: this.jobView(created.job),
      kind: q.kind,
      format: q.format,
      jobCreationIsServerDuty: true as const,
      auditExportDecision: true as const,
    });
  }

  async workerGate(
    query: ExportWorkerQuery | null,
  ): Promise<ExportWorkerGatePassed | ExportServiceFailure> {
    const gate = this.checkShapeStrings(query, ['exportId']);
    if (gate !== null) {
      return gate;
    }
    const context = { exportId: (query as ExportWorkerQuery).exportId };
    const facts: ExportWorkerFacts =
      await this.repository.getWorkerFacts(context);
    if (!facts.exportExists) {
      return this.fail('EXPORT_NOT_FOUND');
    }
    if (
      !facts.meetingExists ||
      facts.kind === null ||
      facts.format === null ||
      facts.meetingKind === null
    ) {
      return this.fail('MEETING_NOT_FOUND');
    }

    const sourceItemsForPolicy =
      facts.kind === 'ANALYSIS'
        ? facts.sourceItems === null
          ? []
          : [...facts.sourceItems]
        : undefined;
    const decision = this.policy.evaluate({
      command: 'WORKER_EXPORT_GATE',
      kind: facts.kind,
      meetingKind: facts.meetingKind,
      surface: 'WORKER',

      exporterAuthorized: facts.exporterAuthorized,

      idempotencyKeyProvided:
        facts.idempotencyKey !== null && facts.idempotencyKey !== '',
      ...(sourceItemsForPolicy === undefined
        ? {}
        : { sourceItems: sourceItemsForPolicy }),
    });
    if (decision.ok !== true) {
      return this.fail(decision.reason);
    }
    return this.freeze({
      ok: true as const,
      k: 'GATE_PASSED' as const,
      exportId: context.exportId,
      meetingId: facts.meetingId as string,
      kind: facts.kind,
      format: facts.format,
    });
  }

  async claimForProcessing(
    query: ExportWorkerQuery | null,
  ): Promise<ExportClaimed | ExportServiceFailure> {
    const recheck = await this.workerGate(query);
    if (recheck.ok !== true) {
      return recheck;
    }
    const context: ExportClaimContext = { exportId: recheck.exportId };
    const claim: ExportClaimResult =
      await this.repository.claimExportForProcessing(context);
    if (claim.claimed) {
      return this.freeze({
        ok: true as const,
        k: 'CLAIMED' as const,
        exportId: context.exportId,
        meetingId: recheck.meetingId,
        kind: recheck.kind,
        format: recheck.format,
      });
    }
    return this.fail(this.claimRefusalReason(claim.refusal));
  }

  async reportCompletion(
    query: ExportCompletionQuery | null,
  ): Promise<ExportCompletionReported | ExportServiceFailure> {
    const gate = this.checkShapeStrings(query, ['exportId']);
    if (gate !== null) {
      return gate;
    }
    const q = query as ExportCompletionQuery;
    if (q.outcome !== 'SUCCEEDED' && q.outcome !== 'FAILED') {
      return this.fail('EXPORT_FACTS_REQUIRED');
    }
    if (q.outcome === 'SUCCEEDED') {
      const recheck = await this.workerGate({ exportId: q.exportId });
      if (recheck.ok !== true) {
        return recheck;
      }
    }
    const request: ReportExportCompletionRequest = {
      exportId: q.exportId,
      outcome: q.outcome,
    };
    const result = await this.repository.reportExportCompletion(request);
    if (result === null) {
      return this.fail('EXPORT_STATUS_CONFLICT');
    }
    if (result.reported !== true) {
      return this.fail(this.reportRefusalReason(result.refusal));
    }
    return this.freeze({
      ok: true as const,
      k: q.outcome === 'SUCCEEDED' ? 'READY' : 'FAILED',
      job: this.jobView(result.job),
    });
  }

  async readExportMetadata(
    query: ExportReadQuery | null,
  ): Promise<ExportMetadataRead | ExportServiceFailure> {
    const gate = this.checkShapeStrings(query, ['exportId', 'requesterId']);
    if (gate !== null) {
      return gate;
    }
    const context: ExportReadContext = this.readContext(query);
    const facts: ExportReadAccessFacts =
      await this.repository.getReadAccessFacts(context);
    if (
      !facts.exportExists ||
      !facts.meetingExists ||
      !facts.requesterIsCreator ||
      !facts.readPermission
    ) {
      return this.fail('EXPORT_NOT_ACCESSIBLE');
    }
    if (facts.status === null) {
      return this.fail('EXPORT_NOT_ACCESSIBLE');
    }
    return this.freeze({
      ok: true as const,
      k: 'METADATA' as const,
      job: this.jobView({
        id: context.exportId,
        status: facts.status,
        expiresAt: facts.expiresAt,
      }),
    });
  }

  async authorizeDownload(
    query: ExportReadQuery | null,
  ): Promise<ExportDownloadAuthorized | ExportServiceFailure> {
    const gate = this.checkShapeStrings(query, ['exportId', 'requesterId']);
    if (gate !== null) {
      return gate;
    }
    const context: ExportReadContext = this.readContext(query);
    const facts: ExportDownloadAccessFacts =
      await this.repository.getDownloadAccessFacts(context);

    if (
      !facts.exportExists ||
      !facts.meetingExists ||
      !facts.requesterIsCreator ||
      !facts.downloadPermission
    ) {
      return this.fail('DOWNLOAD_NOT_AUTHORIZED');
    }
    if (
      facts.kind === null ||
      facts.format === null ||
      facts.meetingKind === null
    ) {
      return this.fail('EXPORT_NOT_ACCESSIBLE');
    }
    const decision = this.policy.evaluate({
      command: 'DOWNLOAD_EXPORT',
      kind: facts.kind,
      meetingKind: facts.meetingKind,
      surface: 'DOWNLOAD',

      exporterAuthorized: facts.requesterIsCreator && facts.downloadPermission,
    });
    if (decision.ok !== true) {
      return this.fail(decision.reason);
    }
    if (facts.status === 'EXPIRED') {
      return this.fail('EXPORT_NOT_DOWNLOADABLE', 'EXPIRED');
    }
    if (facts.status !== 'READY') {
      return this.fail('EXPORT_NOT_DOWNLOADABLE', 'STATUS_NOT_READY');
    }
    if (facts.isExpired) {
      return this.fail('EXPORT_NOT_DOWNLOADABLE', 'EXPIRED');
    }
    await this.repository.recordDownloadAudit(context);
    return this.freeze({
      ok: true as const,
      k: 'DELIVERY_AUTHORIZED' as const,
      job: this.jobView({
        id: context.exportId,
        status: facts.status,
        expiresAt: facts.expiresAt,
      }),
      kind: facts.kind,
      format: facts.format,
      deliveryIsServerDuty: true as const,
      auditRecorded: true as const,
    });
  }

  private createRefusalReason(
    refusal: ExportCreateRefusal,
  ): ExportServiceFailureReason {
    switch (refusal) {
      case 'GENERAL_TARGET_REFUSED':
        return 'GENERAL_EXPORT_REJECTED';
      case 'EXPORTER_RACE_LOST':
        return 'EXPORTER_NOT_AUTHORIZED';
      case 'IDEMPOTENCY_PAYLOAD_MISMATCH':
        return 'IDEMPOTENCY_KEY_CONFLICT';
    }
  }

  private claimRefusalReason(
    refusal: ExportClaimRefusal,
  ): ExportServiceFailureReason {
    switch (refusal) {
      case 'GENERAL_TARGET_REFUSED':
        return 'GENERAL_EXPORT_REJECTED';
      case 'SOURCE_ENUMERATION_UNREADABLE':
        return 'EXPORT_FACTS_REQUIRED';
      case 'ITEM_REJECTED':
        return 'REJECTED_ITEM_NOT_EXPORTABLE';
      case 'EXPORTER_RACE_LOST':
        return 'EXPORTER_NOT_AUTHORIZED';
      case 'NOT_QUEUED':
        return 'EXPORT_STATUS_CONFLICT';
    }
  }

  private reportRefusalReason(
    refusal: ReportExportRefusal,
  ): ExportServiceFailureReason {
    switch (refusal) {
      case 'SOURCE_ENUMERATION_UNREADABLE':
        return 'EXPORT_FACTS_REQUIRED';
      case 'ITEM_REJECTED':
        return 'REJECTED_ITEM_NOT_EXPORTABLE';
      case 'EXPORTER_RACE_LOST':
        return 'EXPORTER_NOT_AUTHORIZED';
      case 'GENERAL_TARGET_REFUSED':
        return 'GENERAL_EXPORT_REJECTED';
    }
  }

  private readContext(query: ExportReadQuery | null): ExportReadContext {
    const q = query as ExportReadQuery;
    return { exportId: q.exportId, requesterId: q.requesterId };
  }

  private checkShapeStrings(
    query: unknown,
    requiredFields: readonly string[],
  ): ExportServiceFailure | null {
    if (query === null || typeof query !== 'object') {
      return this.fail('EXPORT_FACTS_REQUIRED');
    }
    const record = query as Record<string, unknown>;
    for (const field of requiredFields) {
      const value = record[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return this.fail('EXPORT_FACTS_REQUIRED');
      }
    }
    return null;
  }

  private jobView(job: ExportJobContractView): ExportJobContractView {
    return Object.freeze({
      id: job.id,
      status: job.status,
      expiresAt: job.expiresAt,
    });
  }

  private fail(
    reason: ExportServiceFailureReason,
    notDownloadable?: Readonly<'STATUS_NOT_READY' | 'EXPIRED'>,
  ): ExportServiceFailure {
    return notDownloadable === undefined
      ? Object.freeze({ ok: false as const, reason })
      : Object.freeze({ ok: false as const, reason, notDownloadable });
  }

  private freeze<T extends ExportServiceOutcome>(outcome: T): T {
    return Object.freeze(outcome);
  }
}
