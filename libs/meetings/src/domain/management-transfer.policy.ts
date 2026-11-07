import { fingerprint64 } from './approve-remaining.policy';

export const MEETING_LIFECYCLE: Readonly<string[]> = Object.freeze([
  'DRAFT',
  'SCHEDULED',
  'IN_PROGRESS',
  'ENDED',
  'CANCELLED',
]);

export const NONTERMINAL_LIFECYCLE: Readonly<string[]> = Object.freeze([
  'DRAFT',
  'SCHEDULED',
  'IN_PROGRESS',
]);

export type TransferFailure =
  | 'INVALID_REQUEST'
  | 'DECISION_FACTS_REQUIRED'
  | 'UNKNOWN_MEETING_KIND'
  | 'UNKNOWN_LIFECYCLE'
  | 'TERMINAL_MEETING_NOT_TRANSFERABLE'
  | 'MEETING_VERSION_MISMATCH'
  | 'TRANSFER_NOT_AUTHORIZED'
  | 'TARGET_NOT_ELIGIBLE'
  | 'TRANSFER_TOKEN_MISMATCH';

export type TransferFailureDecision = Readonly<{
  ok: false;
  reason: TransferFailure;
  preventEnumeration: boolean;
}>;

export type TransferAcceptDecision = Readonly<{ ok: true }>;
export type TransferInitiateDecision = Readonly<{
  ok: true;
  transferId: string;
}>;

export type TransferGuardDecision =
  TransferAcceptDecision | TransferFailureDecision;

export type TransferWorkflowDecision =
  TransferAcceptDecision | TransferInitiateDecision | TransferFailureDecision;

export interface TransferFacts {
  readonly meetingId: string;

  readonly transfererAuthorized: boolean;

  readonly transfererDeptMatches: boolean;
  readonly meetingKind: string;
  readonly meetingLifecycle: string;

  readonly expectedMeetingVersion: number;
  readonly currentMeetingVersion: number;

  readonly oldMeetingAdminId: string;
  readonly newManagerUserId: string;

  readonly targetEligible: boolean;
  readonly reason: string;
}

export interface CommitTransferFacts {
  readonly meetingId: string;

  readonly expectedMeetingVersion: number;
  readonly currentMeetingVersion: number;
  readonly meetingKind: string;
  readonly meetingLifecycle: string;
  readonly oldMeetingAdminId: string;
  readonly newManagerUserId: string;
  readonly reason: string;

  readonly transfererAuthorized: boolean;
  readonly transfererDeptMatches: boolean;
  readonly transfererStillAuthorizedAfterRereview: boolean;

  readonly targetStillEligible: boolean;
}

export class ManagementTransferPolicy {
  initiateTransfer(
    request: unknown,
  ): TransferInitiateDecision | TransferFailureDecision {
    const factsCheck = this.checkCommonFacts(request);
    if (factsCheck.ok !== true) {
      return factsCheck;
    }
    const facts = request as TransferFacts;
    const authorization = this.authorizeTransferer(
      facts.transfererAuthorized,
      facts.transfererDeptMatches,
      facts.meetingKind,
    );
    if (authorization.ok !== true) {
      return authorization;
    }
    if (facts.expectedMeetingVersion !== facts.currentMeetingVersion) {
      return this.reject('MEETING_VERSION_MISMATCH', false);
    }
    const targetInput = this.checkTargetManagerInput(facts.newManagerUserId);
    if (targetInput.ok !== true) {
      return targetInput;
    }
    if (facts.targetEligible !== true) {
      return this.reject('TARGET_NOT_ELIGIBLE', false);
    }
    if (facts.newManagerUserId === facts.oldMeetingAdminId) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    return Object.freeze({
      ok: true as const,
      transferId: this.composeTransferId(
        facts.meetingId,
        facts.oldMeetingAdminId,
        facts.newManagerUserId,
        facts.reason,
        facts.expectedMeetingVersion,
      ),
    });
  }

  commitTransfer(
    request: unknown,
    statedTransferIdFingerprint: string,
    storedTransferIdFingerprint?: string,
  ): TransferGuardDecision {
    const factsCheck = this.checkCommonFacts(request);
    if (factsCheck.ok !== true) {
      return factsCheck;
    }
    const facts = request as CommitTransferFacts;
    const authorization = this.authorizeTransferer(
      facts.transfererAuthorized,
      facts.transfererDeptMatches,
      facts.meetingKind,
    );
    if (authorization.ok !== true) {
      return authorization;
    }
    if (facts.transfererStillAuthorizedAfterRereview !== true) {
      return this.reject('TRANSFER_NOT_AUTHORIZED', false);
    }
    if (facts.expectedMeetingVersion !== facts.currentMeetingVersion) {
      return this.reject('MEETING_VERSION_MISMATCH', false);
    }
    const targetInput = this.checkTargetManagerInput(facts.newManagerUserId);
    if (targetInput.ok !== true) {
      return targetInput;
    }
    if (facts.newManagerUserId === facts.oldMeetingAdminId) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }

    const recomputed = this.composeTransferId(
      facts.meetingId,
      facts.oldMeetingAdminId,
      facts.newManagerUserId,
      facts.reason,
      facts.expectedMeetingVersion,
    );
    if (
      typeof statedTransferIdFingerprint !== 'string' ||
      statedTransferIdFingerprint !== recomputed ||
      (storedTransferIdFingerprint !== undefined &&
        storedTransferIdFingerprint !== recomputed)
    ) {
      return this.reject('TRANSFER_TOKEN_MISMATCH', false);
    }
    if (facts.targetStillEligible !== true) {
      return this.reject('TARGET_NOT_ELIGIBLE', false);
    }
    return Object.freeze({ ok: true as const });
  }

  private checkCommonFacts(request: unknown): TransferGuardDecision {
    if (request === null || typeof request !== 'object') {
      return this.reject('INVALID_REQUEST', false);
    }
    const facts = request as Partial<TransferFacts>;
    if (typeof facts.meetingId !== 'string' || facts.meetingId.trim() === '') {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (
      typeof facts.meetingKind !== 'string' ||
      facts.meetingKind.trim() === ''
    ) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (
      facts.meetingKind !== 'TECH' &&
      facts.meetingKind !== 'SALES' &&
      facts.meetingKind !== 'GENERAL'
    ) {
      return this.reject('UNKNOWN_MEETING_KIND', false);
    }
    if (
      typeof facts.meetingLifecycle !== 'string' ||
      facts.meetingLifecycle.trim() === ''
    ) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (MEETING_LIFECYCLE.indexOf(facts.meetingLifecycle) === -1) {
      return this.reject('UNKNOWN_LIFECYCLE', false);
    }
    if (NONTERMINAL_LIFECYCLE.indexOf(facts.meetingLifecycle) === -1) {
      return this.reject('TERMINAL_MEETING_NOT_TRANSFERABLE', false);
    }
    if (
      !this.isSafePositive(facts.expectedMeetingVersion) ||
      !this.isSafePositive(facts.currentMeetingVersion)
    ) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    for (const field of ['oldMeetingAdminId', 'reason'] as const) {
      const value = facts[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return this.reject('DECISION_FACTS_REQUIRED', false);
      }
    }
    return Object.freeze({ ok: true as const });
  }

  checkTargetManagerInput(userId: unknown): TransferGuardDecision {
    if (typeof userId !== 'string' || userId.trim() === '') {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    return Object.freeze({ ok: true as const });
  }

  composeTransferId(
    meetingId: string,
    oldMeetingAdminId: string,
    newManagerUserId: string,
    reason: string,
    consumedMeetingVersion: number,
  ): string {
    if (
      !Number.isSafeInteger(consumedMeetingVersion) ||
      consumedMeetingVersion < 0
    )
      throw new RangeError('A current consumed meeting version is required');
    const canonical =
      `${consumedMeetingVersion}|` +
      `${meetingId.length}:${meetingId}|` +
      `${oldMeetingAdminId.length}:${oldMeetingAdminId}|` +
      `${newManagerUserId.length}:${newManagerUserId}|` +
      `${reason.length}:${reason}`;
    return fingerprint64(canonical);
  }

  private authorizeTransferer(
    transfererAuthorized: unknown,
    transfererDeptMatches: unknown,
    meetingKind: string,
  ): TransferGuardDecision {
    if (transfererAuthorized !== true && transfererAuthorized !== false) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (transfererAuthorized !== true) {
      return this.reject('TRANSFER_NOT_AUTHORIZED', false);
    }
    if (transfererDeptMatches !== true && transfererDeptMatches !== false) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (meetingKind === 'GENERAL' && transfererDeptMatches === true) {
      return this.reject('TRANSFER_NOT_AUTHORIZED', false);
    }

    return Object.freeze({ ok: true as const });
  }

  private isSafePositive(value: unknown): value is number {
    return (
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    );
  }

  private reject(
    reason: TransferFailure,
    preventEnumeration: boolean,
  ): TransferFailureDecision {
    return Object.freeze({ ok: false as const, reason, preventEnumeration });
  }
}
