type ItemStatus = 'PENDING' | 'NEEDS_EDITS' | 'REJECTED' | 'APPROVED';

type ReviewCommand = 'REVIEW_EDIT' | 'REJECT_ITEM' | 'APPROVE_ITEM';

type DuplicateDecisionStatus = 'COMPLETED' | 'PENDING';

export interface AnalysisReviewRequest {
  readonly command: string;
  readonly itemStatus: string;

  readonly approverAuthorizedAtWriteTime?: boolean;

  readonly reviewerAuthorized?: boolean;
  readonly accessVerified?: boolean;
  readonly currentItemVersion?: number;
  readonly expectedItemVersion?: number;
  readonly schemaFieldsValidated?: boolean;

  readonly evidenceValid?: boolean;

  readonly duplicateDecision?: DuplicateDecisionStatus;
  readonly rejectReason?: string;

  readonly reviewRevisionRecorded?: boolean;
  readonly generateExecution?: boolean;
  readonly meetingKind?: string;
}

export interface AnalysisReviewOutcome {
  readonly ok: true;
  readonly command: ReviewCommand;
  readonly from: ItemStatus;
  readonly to: ItemStatus;

  readonly itemVersionBumped: boolean;

  readonly newApprovalRevisionRequired: boolean;

  readonly auditReasonRecorded: boolean;

  readonly approvedSnapshotImmutable: boolean;
}

export type AnalysisReviewDecision =
  AnalysisReviewOutcome | Readonly<{ ok: false; reason: ReviewFailure }>;

type ReviewFailure =
  | 'INVALID_COMMAND'
  | 'UNKNOWN_ITEM_STATUS'
  | 'DECISION_FACTS_REQUIRED'
  | 'VERSION_MISMATCH'
  | 'APPROVER_NOT_AUTHORIZED'
  | 'REVIEWER_NOT_AUTHORIZED'
  | 'REJECT_REASON_REQUIRED'
  | 'REVIEW_REVISION_REQUIRED'
  | 'DUPLICATE_DECISION_PENDING'
  | 'EVIDENCE_NOT_VALID'
  | 'FIELDS_NOT_VALIDATED'
  | 'ALREADY_APPROVED'
  | 'ALREADY_REJECTED'
  | 'APPROVE_NOT_ALLOWED'
  | 'REJECT_NOT_ALLOWED'
  | 'EDIT_NOT_ALLOWED'
  | 'GENERAL_EXTERNAL_EXECUTION_REJECTED';

const ITEM_STATUSES: Readonly<ItemStatus[]> = [
  'PENDING',
  'NEEDS_EDITS',
  'REJECTED',
  'APPROVED',
];
const REVIEW_COMMANDS: Readonly<ReviewCommand[]> = [
  'REVIEW_EDIT',
  'REJECT_ITEM',
  'APPROVE_ITEM',
];
const DUPLICATE_DECISIONS: Readonly<DuplicateDecisionStatus[]> = [
  'COMPLETED',
  'PENDING',
];
const GENERAL_KIND = 'GENERAL';

const MEETING_KINDS: Readonly<string[]> = Object.freeze([
  'TECH',
  'SALES',
  'GENERAL',
]);

export class AnalysisReviewPolicy {
  evaluate(request: AnalysisReviewRequest): AnalysisReviewDecision {
    const shapeFailure = this.requestShapeFailure(request);
    if (shapeFailure !== null) {
      return this.reject(shapeFailure);
    }
    const command = request.command as ReviewCommand;
    const from = request.itemStatus as ItemStatus;

    if (command === 'APPROVE_ITEM') {
      return this.evaluateApproval(request, from);
    }

    if (command === 'REJECT_ITEM') {
      return this.evaluateRejection(request, from);
    }

    return this.evaluateEdit(request, from);
  }

  private evaluateApproval(
    request: AnalysisReviewRequest,
    from: ItemStatus,
  ): AnalysisReviewDecision {
    if (from === 'APPROVED') {
      return this.reject('ALREADY_APPROVED');
    }
    if (from !== 'PENDING') {
      return this.reject('APPROVE_NOT_ALLOWED');
    }

    if (
      request.generateExecution === true &&
      request.meetingKind === undefined
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }

    if (
      request.meetingKind === GENERAL_KIND &&
      request.generateExecution === true
    ) {
      return this.reject('GENERAL_EXTERNAL_EXECUTION_REJECTED');
    }
    if (request.approverAuthorizedAtWriteTime !== true) {
      return this.reject('APPROVER_NOT_AUTHORIZED');
    }
    const versionFailure = this.itemVersionFailure(request);
    if (versionFailure !== null) {
      return this.reject(versionFailure);
    }
    if (request.duplicateDecision !== 'COMPLETED') {
      return this.reject('DUPLICATE_DECISION_PENDING');
    }
    if (request.schemaFieldsValidated !== true) {
      return this.reject('FIELDS_NOT_VALIDATED');
    }
    if (request.evidenceValid !== true) {
      return this.reject('EVIDENCE_NOT_VALID');
    }
    return Object.freeze({
      ok: true as const,
      command: 'APPROVE_ITEM' as const,
      from,
      to: 'APPROVED' as const,
      itemVersionBumped: false,
      newApprovalRevisionRequired: false,
      auditReasonRecorded: false,
      approvedSnapshotImmutable: true,
    });
  }

  private evaluateRejection(
    request: AnalysisReviewRequest,
    from: ItemStatus,
  ): AnalysisReviewDecision {
    if (from === 'APPROVED') {
      return this.reject('REJECT_NOT_ALLOWED');
    }
    if (from === 'REJECTED') {
      return this.reject('ALREADY_REJECTED');
    }
    if (
      request.reviewerAuthorized !== true &&
      request.approverAuthorizedAtWriteTime !== true
    )
      return this.reject('REVIEWER_NOT_AUTHORIZED');
    if (request.accessVerified !== true)
      return this.reject('DECISION_FACTS_REQUIRED');
    const versionFailure = this.itemVersionFailure(request);
    if (versionFailure !== null) return this.reject(versionFailure);
    if (
      typeof request.rejectReason !== 'string' ||
      request.rejectReason.trim().length === 0
    ) {
      return this.reject('REJECT_REASON_REQUIRED');
    }
    return Object.freeze({
      ok: true as const,
      command: 'REJECT_ITEM' as const,
      from,
      to: 'REJECTED' as const,
      itemVersionBumped: false,
      newApprovalRevisionRequired: false,
      auditReasonRecorded: true,
      approvedSnapshotImmutable: false,
    });
  }

  private evaluateEdit(
    request: AnalysisReviewRequest,
    from: ItemStatus,
  ): AnalysisReviewDecision {
    if (from === 'REJECTED') {
      return this.reject('EDIT_NOT_ALLOWED');
    }
    if (request.reviewerAuthorized !== true)
      return this.reject('REVIEWER_NOT_AUTHORIZED');
    if (request.accessVerified !== true)
      return this.reject('DECISION_FACTS_REQUIRED');
    const versionFailure = this.itemVersionFailure(request);
    if (versionFailure !== null) return this.reject(versionFailure);
    if (from === 'APPROVED') {
      return Object.freeze({
        ok: true as const,
        command: 'REVIEW_EDIT' as const,
        from,
        to: 'APPROVED' as const,
        itemVersionBumped: false,
        newApprovalRevisionRequired: true,
        auditReasonRecorded: false,
        approvedSnapshotImmutable: true,
      });
    }
    if (request.reviewRevisionRecorded !== true) {
      return this.reject('REVIEW_REVISION_REQUIRED');
    }
    return Object.freeze({
      ok: true as const,
      command: 'REVIEW_EDIT' as const,
      from,
      to: from,
      itemVersionBumped: true,
      newApprovalRevisionRequired: false,
      auditReasonRecorded: false,
      approvedSnapshotImmutable: false,
    });
  }

  private itemVersionFailure(
    request: AnalysisReviewRequest,
  ): ReviewFailure | null {
    if (
      typeof request.currentItemVersion !== 'number' ||
      !Number.isInteger(request.currentItemVersion) ||
      typeof request.expectedItemVersion !== 'number' ||
      !Number.isInteger(request.expectedItemVersion)
    ) {
      return 'DECISION_FACTS_REQUIRED';
    }
    if (request.currentItemVersion !== request.expectedItemVersion) {
      return 'VERSION_MISMATCH';
    }
    return null;
  }

  private requestShapeFailure(
    request: AnalysisReviewRequest,
  ): ReviewFailure | null {
    if (request === null || typeof request !== 'object') {
      return 'INVALID_COMMAND';
    }
    if (REVIEW_COMMANDS.indexOf(request.command as ReviewCommand) === -1) {
      return 'INVALID_COMMAND';
    }
    if (ITEM_STATUSES.indexOf(request.itemStatus as ItemStatus) === -1) {
      return 'UNKNOWN_ITEM_STATUS';
    }
    if (
      request.duplicateDecision !== undefined &&
      DUPLICATE_DECISIONS.indexOf(request.duplicateDecision) === -1
    ) {
      return 'DECISION_FACTS_REQUIRED';
    }

    if (
      request.generateExecution !== undefined &&
      request.generateExecution !== true &&
      request.generateExecution !== false
    ) {
      return 'DECISION_FACTS_REQUIRED';
    }

    if (
      request.meetingKind !== undefined &&
      (typeof request.meetingKind !== 'string' ||
        MEETING_KINDS.indexOf(request.meetingKind) === -1)
    ) {
      return 'DECISION_FACTS_REQUIRED';
    }
    return null;
  }

  private reject(reason: ReviewFailure): AnalysisReviewDecision {
    return Object.freeze({ ok: false as const, reason });
  }
}
