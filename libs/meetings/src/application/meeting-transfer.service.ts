import {
  ManagementTransferPolicy,
  type CommitTransferFacts,
  type TransferFacts,
  type TransferFailure,
} from '../domain/management-transfer.policy';
import type {
  ManagementTransferRecord,
  MeetingTransferRepository,
} from './meeting-transfer.repository';

export type { MeetingTransferRepository } from './meeting-transfer.repository';

export type TransferFailureDecision = Readonly<{
  ok: false;
  reason: TransferFailure;
  preventEnumeration: boolean;
}>;

export interface InitiateTransferResult {
  readonly ok: true;
  readonly state: 'INITIATED';

  readonly transferId: string;

  readonly revokeOldPermissionsAtomically: true;
  readonly notifyOldAndNew: true;
}

export interface CommitTransferResult {
  readonly ok: true;
  readonly state: 'COMMITTED';
  readonly transfer: ManagementTransferRecord;

  readonly meetingVersion: number;
}

export interface CommitTransferQuery {
  readonly meetingId: string;

  readonly transferId: string;

  readonly changedById: string;

  readonly createdAt: string;
  readonly facts: CommitTransferFacts;
}

const ISO_8601_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export class ManagementTransferService {
  private readonly policy: ManagementTransferPolicy;
  private readonly repository: MeetingTransferRepository;

  constructor(
    repository: MeetingTransferRepository,
    policy?: ManagementTransferPolicy,
  ) {
    this.repository = repository;
    this.policy = policy ?? new ManagementTransferPolicy();
  }

  initiateTransfer(
    facts: TransferFacts | null,
  ): Promise<InitiateTransferResult | TransferFailureDecision> {
    if (facts === null || typeof facts !== 'object') {
      return Promise.resolve(
        Object.freeze({
          ok: false as const,
          reason: 'DECISION_FACTS_REQUIRED',
          preventEnumeration: false,
        }),
      );
    }
    const decision = this.policy.initiateTransfer(facts);
    if (decision.ok !== true) {
      return Promise.resolve(decision);
    }
    return Promise.resolve(
      Object.freeze({
        ok: true as const,
        state: 'INITIATED' as const,
        transferId: decision.transferId,
        revokeOldPermissionsAtomically: true as const,
        notifyOldAndNew: true as const,
      }),
    );
  }

  async commitTransfer(
    query: CommitTransferQuery | null,
  ): Promise<CommitTransferResult | TransferFailureDecision> {
    if (query === null || typeof query !== 'object') {
      return Object.freeze({
        ok: false as const,
        reason: 'DECISION_FACTS_REQUIRED',
        preventEnumeration: false,
      });
    }
    for (const field of [
      'meetingId',
      'transferId',
      'changedById',
      'createdAt',
    ] as const) {
      const value = query[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return this.requiredFacts();
      }
    }
    if (!ISO_8601_INSTANT.test(query.createdAt)) {
      return this.requiredFacts();
    }
    if (query.facts === null || typeof query.facts !== 'object') {
      return this.requiredFacts();
    }
    const commitFacts = query.facts;
    if (commitFacts.meetingId !== query.meetingId) {
      return this.requiredFacts();
    }
    const decision = this.policy.commitTransfer(commitFacts, query.transferId);
    if (decision.ok !== true) {
      return decision;
    }
    const record: ManagementTransferRecord = {
      id: query.transferId,
      meetingId: query.meetingId,
      oldMeetingAdminId: commitFacts.oldMeetingAdminId,
      newMeetingAdminId: commitFacts.newManagerUserId,
      changedById: query.changedById,
      reason: commitFacts.reason,
      createdAt: query.createdAt,
    };
    const committed = await this.repository.commitManagerTransfer(
      record,
      commitFacts.expectedMeetingVersion,
    );
    return Object.freeze({
      ok: true as const,
      state: 'COMMITTED' as const,
      transfer: committed.record,
      meetingVersion: committed.meetingVersion,
    });
  }

  private requiredFacts(): TransferFailureDecision {
    return Object.freeze({
      ok: false as const,
      reason: 'DECISION_FACTS_REQUIRED',
      preventEnumeration: false,
    });
  }
}
