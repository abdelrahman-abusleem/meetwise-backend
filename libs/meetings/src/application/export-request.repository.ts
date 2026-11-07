export type ExportStatus =
  'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'EXPIRED';

export type ExportKind = 'SUMMARY' | 'TRANSCRIPT' | 'ANALYSIS';

export type ExportFormat = 'JSON' | 'CSV' | 'PDF';

export type ExportSourceItemStatus =
  'PENDING' | 'NEEDS_EDITS' | 'REJECTED' | 'APPROVED';

export interface ExportJobContractView {
  readonly id: string;
  readonly status: ExportStatus;
  readonly expiresAt: string | null;
}

export type ExportCreateOutcomeName = 'QUEUED' | 'EXISTING';

export type ExportCreateRefusal =
  | 'GENERAL_TARGET_REFUSED'
  | 'EXPORTER_RACE_LOST'
  | 'IDEMPOTENCY_PAYLOAD_MISMATCH';

export type ExportClaimRefusal =
  | 'GENERAL_TARGET_REFUSED'
  | 'SOURCE_ENUMERATION_UNREADABLE'
  | 'ITEM_REJECTED'
  | 'EXPORTER_RACE_LOST'
  | 'NOT_QUEUED';

export interface ExportRequestFacts {
  readonly meetingExists: boolean;

  readonly meetingKind: string;

  readonly exporterAuthorized: boolean;
}

export interface ExportSourceItem {
  readonly id: string;
  readonly status: string;
}

export interface ExportWorkerContext {
  readonly exportId: string;
}

export interface ExportWorkerFacts {
  readonly exportExists: boolean;
  readonly kind: ExportKind | null;
  readonly format: ExportFormat | null;
  readonly meetingId: string | null;
  readonly meetingExists: boolean;
  readonly meetingKind: string | null;
  readonly exporterAuthorized: boolean;
  readonly idempotencyKey: string | null;
  readonly sourceItems: readonly ExportSourceItem[] | null;
}

export interface CreateExportJobRequest {
  readonly meetingId: string;

  readonly requesterId: string;
  readonly kind: ExportKind;
  readonly format: ExportFormat;

  readonly idempotencyKey: string;
}

export type CreateExportJobResult =
  | { readonly created: true; readonly job: ExportJobContractView }
  | { readonly created: false; readonly job: ExportJobContractView }
  | {
      readonly created: false;
      readonly refusal: ExportCreateRefusal;
      readonly job: null;
    };

export interface ExportClaimContext {
  readonly exportId: string;
}

export type ExportClaimResult =
  | {
      readonly claimed: true;
      readonly refusal: null;
      readonly currentStatus: ExportStatus;
    }
  | {
      readonly claimed: false;
      readonly refusal: ExportClaimRefusal;
      readonly currentStatus: ExportStatus;
    };

export interface ReportExportCompletionRequest {
  readonly exportId: string;

  readonly outcome: 'SUCCEEDED' | 'FAILED';
}

export type ReportExportRefusal =
  | 'SOURCE_ENUMERATION_UNREADABLE'
  | 'ITEM_REJECTED'
  | 'EXPORTER_RACE_LOST'
  | 'GENERAL_TARGET_REFUSED';

export type ReportExportCompletionResult =
  | { readonly reported: true; readonly job: ExportJobContractView }
  | { readonly reported: false; readonly refusal: ReportExportRefusal }
  | null;

export interface ExportReadContext {
  readonly exportId: string;

  readonly requesterId: string;
}

export interface ExportReadAccessFacts {
  readonly exportExists: boolean;
  readonly meetingExists: boolean;
  readonly requesterIsCreator: boolean;

  readonly readPermission: boolean;
  readonly status: ExportStatus | null;
  readonly expiresAt: string | null;
}

export interface ExportDownloadAccessFacts {
  readonly exportExists: boolean;
  readonly meetingExists: boolean;
  readonly requesterIsCreator: boolean;

  readonly downloadPermission: boolean;
  readonly kind: ExportKind | null;
  readonly format: ExportFormat | null;
  readonly status: ExportStatus | null;
  readonly expiresAt: string | null;
  readonly isExpired: boolean;

  readonly meetingKind: string | null;
}

export interface ExportDownloadAuditContext {
  readonly exportId: string;
  readonly requesterId: string;
}

export interface ExportRequestRepository {
  getExportRequestFacts(context: {
    readonly meetingId: string;
    readonly requesterId: string;
  }): Promise<ExportRequestFacts>;

  createExportJob(
    request: CreateExportJobRequest,
  ): Promise<CreateExportJobResult>;

  getWorkerFacts(context: ExportWorkerContext): Promise<ExportWorkerFacts>;

  claimExportForProcessing(
    context: ExportClaimContext,
  ): Promise<ExportClaimResult>;

  reportExportCompletion(
    request: ReportExportCompletionRequest,
  ): Promise<ReportExportCompletionResult>;

  getReadAccessFacts(
    context: ExportReadContext,
  ): Promise<ExportReadAccessFacts>;

  getDownloadAccessFacts(
    context: ExportReadContext,
  ): Promise<ExportDownloadAccessFacts>;

  recordDownloadAudit(context: ExportDownloadAuditContext): Promise<void>;
}
