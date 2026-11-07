import {
  MeetingAssignmentPolicy,
  type AssignmentDecision,
  type AssignmentFailure,
} from '../domain/meeting-assignment.policy';
import type {
  MeetingAssignmentRecord,
  MeetingAssignmentRepository,
} from './meeting-assignment.repository';

export type { MeetingAssignmentRepository } from './meeting-assignment.repository';

export type AssignmentFailureDecision = Readonly<{
  ok: false;
  reason: AssignmentFailure;
  preventEnumeration: boolean;
  offendingUserIds?: readonly string[];
}>;

export interface AssignResult {
  readonly ok: true;
  readonly k: 'ASSIGN';
  readonly role: 'APPROVER' | 'REVIEWER';

  readonly assignments: readonly MeetingAssignmentRecord[];

  readonly grantsReviewerOnly: boolean;
}

export interface RevokeResult {
  readonly ok: true;
  readonly k: 'REVOKE';
  readonly role: 'APPROVER' | 'REVIEWER';
  readonly revokedAssignmentId: string;
}

export interface AssignQuery {
  readonly meetingId: string;

  readonly assignedById: string;
  readonly facts: Record<string, unknown>;
}

export interface RevokeQuery {
  readonly meetingId: string;
  readonly assignmentId: string;
  readonly facts: Record<string, unknown>;
}

export class MeetingAssignmentService {
  private readonly policy: MeetingAssignmentPolicy;
  private readonly repository: MeetingAssignmentRepository;

  constructor(
    repository: MeetingAssignmentRepository,
    policy?: MeetingAssignmentPolicy,
  ) {
    this.repository = repository;
    this.policy = policy ?? new MeetingAssignmentPolicy();
  }

  async assign(
    query: AssignQuery | null,
  ): Promise<AssignResult | AssignmentFailureDecision> {
    const gate = this.checkQueryShape(query, ['assignedById']);
    if (gate !== null) {
      return gate;
    }
    const q = query as AssignQuery;

    const factsSnapshot = Object.freeze({
      ...q.facts,
    });

    if (factsSnapshot.meetingId !== q.meetingId) {
      return this.requiredFacts();
    }
    if (factsSnapshot.assignerUserId !== q.assignedById) {
      return this.requiredFacts();
    }
    const decision: AssignmentDecision = this.policy.decide({
      ...factsSnapshot,

      command: 'ASSIGN',
    });
    if (decision.ok !== true) {
      return decision;
    }
    if (decision.k !== 'ASSIGN') {
      return this.requiredFacts();
    }
    const userIds = factsSnapshot.userIds as readonly string[];
    if (decision.assignmentIds.length !== userIds.length) {
      return this.requiredFacts();
    }
    const role = factsSnapshot.role as 'APPROVER' | 'REVIEWER';
    const records: MeetingAssignmentRecord[] = [];
    for (let index = 0; index < userIds.length; index += 1) {
      const userId = userIds[index],
        id = decision.assignmentIds[index];
      if (typeof userId !== 'string' || typeof id !== 'string') {
        return this.requiredFacts();
      }
      records.push({
        id,
        meetingId: q.meetingId,
        userId,
        assignedById: q.assignedById,
      });
    }
    const created = await this.repository.createAssignments(role, records);
    return Object.freeze({
      ok: true as const,
      k: 'ASSIGN' as const,
      role,
      assignments: Object.freeze(
        created.created.map((r) =>
          Object.freeze({
            id: r.id,
            meetingId: r.meetingId,
            userId: r.userId,
            assignedById: r.assignedById,
          }),
        ),
      ),
      grantsReviewerOnly: decision.grantsReviewerOnly,
    });
  }

  async revoke(
    query: RevokeQuery | null,
  ): Promise<RevokeResult | AssignmentFailureDecision> {
    const gate = this.checkQueryShape(query, ['assignmentId']);
    if (gate !== null) {
      return gate;
    }
    const q = query as RevokeQuery;

    const factsSnapshot = Object.freeze({
      ...q.facts,
    });

    if (factsSnapshot.meetingId !== q.meetingId) {
      return this.requiredFacts();
    }
    const decision: AssignmentDecision = this.policy.decide({
      ...factsSnapshot,

      command: 'REVOKE',
      assignmentId: q.assignmentId,
    });
    if (decision.ok !== true) {
      return decision;
    }
    if (decision.k !== 'REVOKE') {
      return this.requiredFacts();
    }
    const role = factsSnapshot.role as 'APPROVER' | 'REVIEWER';
    await (role === 'APPROVER'
      ? this.repository.revokeMeetingApproverAssignment(
          q.assignmentId,
          q.meetingId,
          factsSnapshot.assignerUserId as string,
        )
      : this.repository.revokeMeetingReviewerAssignment(
          q.assignmentId,
          q.meetingId,
          factsSnapshot.assignerUserId as string,
        ));
    return Object.freeze({
      ok: true as const,
      k: 'REVOKE' as const,
      role,
      revokedAssignmentId: q.assignmentId,
    });
  }

  private checkQueryShape(
    query: AssignQuery | RevokeQuery | null,
    extraFields: readonly string[],
  ): AssignmentFailureDecision | null {
    if (query === null || typeof query !== 'object') {
      return this.requiredFacts();
    }
    for (const field of ['meetingId', ...extraFields]) {
      const value = (query as unknown as Record<string, unknown>)[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return this.requiredFacts();
      }
    }
    if (query.facts === null || typeof query.facts !== 'object') {
      return this.requiredFacts();
    }
    return null;
  }

  private requiredFacts(): AssignmentFailureDecision {
    return Object.freeze({
      ok: false as const,
      reason: 'DECISION_FACTS_REQUIRED' as const,
      preventEnumeration: false,
    });
  }
}
