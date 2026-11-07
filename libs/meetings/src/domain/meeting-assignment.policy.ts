import { fingerprint64 } from './approve-remaining.policy';

export const MEETING_KINDS: Readonly<string[]> = Object.freeze([
  'TECH',
  'SALES',
  'GENERAL',
]);

export type AssignmentFailure =
  | 'INVALID_REQUEST'
  | 'DECISION_FACTS_REQUIRED'
  | 'UNKNOWN_MEETING_KIND'
  | 'ASSIGNER_NOT_AUTHORIZED'
  | 'TARGET_NOT_ELIGIBLE'
  | 'GENERAL_ASSIGNER_NOT_AUTHORIZED';

export type AssignmentFailureDecision = Readonly<{
  ok: false;
  reason: AssignmentFailure;

  preventEnumeration: boolean;

  offendingUserIds?: readonly string[];
}>;

export type AssignmentAcceptDecision = Readonly<{ ok: true }>;

export type AssignAllotmentDecision = Readonly<{
  ok: true;

  k: 'ASSIGN';
  assignmentIds: readonly string[];

  grantsReviewerOnly: boolean;
}>;

export type RevokeDecision = Readonly<{
  ok: true;

  k: 'REVOKE';
  revokedAssignmentId: string;
}>;

export type AssignmentGuardDecision =
  AssignmentAcceptDecision | AssignmentFailureDecision;

export type AssignmentDecision =
  AssignAllotmentDecision | RevokeDecision | AssignmentFailureDecision;

export type AssignerScope = 'GLOBAL' | 'DEPARTMENT' | 'MEETING_DELEGATED';

export interface AssignmentFacts {
  readonly command: string;
  readonly role: string;
  readonly meetingId: string;
  readonly meetingKind: string;
  readonly assignerUserId: string;

  readonly assignerScope: AssignerScope;

  readonly meetingScopeDelegationVerified?: boolean;

  readonly userIds?: readonly unknown[];

  readonly eligibleUserIds?: readonly unknown[];

  readonly assignmentId?: string;

  readonly privileges?: string;
}

export class MeetingAssignmentPolicy {
  static readonly COMMANDS = Object.freeze([
    'ASSIGN',
    'REVOKE',
  ] as readonly string[]);
  static readonly ROLES = Object.freeze([
    'APPROVER',
    'REVIEWER',
  ] as readonly string[]);
  static readonly ASSIGNER_SCOPES = Object.freeze([
    'GLOBAL',
    'DEPARTMENT',
    'MEETING_DELEGATED',
  ] as readonly string[]);

  decide(request: unknown): AssignmentDecision {
    if (request === null || typeof request !== 'object') {
      return this.reject('INVALID_REQUEST', false);
    }
    const facts = request as Partial<AssignmentFacts>;
    if (
      typeof facts.command !== 'string' ||
      MeetingAssignmentPolicy.COMMANDS.indexOf(facts.command) === -1
    ) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (
      typeof facts.role !== 'string' ||
      MeetingAssignmentPolicy.ROLES.indexOf(facts.role) === -1
    ) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    for (const field of [
      'meetingId',
      'meetingKind',
      'assignerUserId',
    ] as const) {
      const value = facts[field];
      if (typeof value !== 'string' || value.trim() === '') {
        return this.reject('DECISION_FACTS_REQUIRED', false);
      }
    }
    if (MEETING_KINDS.indexOf(facts.meetingKind as string) === -1) {
      return this.reject('UNKNOWN_MEETING_KIND', false);
    }
    if (
      typeof facts.assignerScope !== 'string' ||
      MeetingAssignmentPolicy.ASSIGNER_SCOPES.indexOf(facts.assignerScope) ===
        -1
    ) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (
      facts.privileges !== undefined &&
      typeof facts.privileges !== 'string'
    ) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }

    if (facts.command === 'REVOKE') {
      if (
        typeof facts.assignmentId !== 'string' ||
        facts.assignmentId.trim() === ''
      ) {
        return this.reject('DECISION_FACTS_REQUIRED', false);
      }
      const authorization = this.authorizeAssigner(facts);
      if (authorization.ok !== true) {
        return authorization;
      }
      return Object.freeze({
        ok: true as const,
        k: 'REVOKE' as const,
        revokedAssignmentId: facts.assignmentId,
      });
    }

    if (!Array.isArray(facts.userIds) || facts.userIds.length === 0) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    for (const user of facts.userIds) {
      if (typeof user !== 'string' || user.trim() === '') {
        return this.reject('DECISION_FACTS_REQUIRED', false);
      }
    }
    if (new Set(facts.userIds as string[]).size !== facts.userIds.length) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    if (!Array.isArray(facts.eligibleUserIds)) {
      return this.reject('DECISION_FACTS_REQUIRED', false);
    }
    const authorization = this.authorizeAssigner(facts);
    if (authorization.ok !== true) {
      return authorization;
    }
    const eligible = facts.eligibleUserIds as readonly string[];
    const ineligible = (facts.userIds as string[]).filter(
      (user) => !eligible.some((candidate) => candidate === user),
    );
    if (ineligible.length > 0) {
      return Object.freeze({
        ok: false as const,
        reason: 'TARGET_NOT_ELIGIBLE' as const,
        preventEnumeration: false,
        offendingUserIds: Object.freeze([...ineligible]),
      });
    }

    const typed = facts as AssignmentFacts;
    const requested = typed.userIds as readonly string[];
    const ids = requested.map((user) =>
      fingerprint64(
        `${typed.meetingId.length}:${typed.meetingId}|` +
          `${user.length}:${user}|` +
          `${typed.role.length}:${typed.role}|` +
          `${typed.assignerUserId.length}:${typed.assignerUserId}`,
      ),
    );
    return Object.freeze({
      ok: true as const,
      k: 'ASSIGN' as const,
      assignmentIds: Object.freeze(ids),
      grantsReviewerOnly: facts.role === 'REVIEWER',
    });
  }

  private authorizeAssigner(
    facts: Partial<AssignmentFacts>,
  ): AssignmentGuardDecision {
    if (facts.meetingKind === 'GENERAL' && facts.assignerScope !== 'GLOBAL') {
      return this.reject('GENERAL_ASSIGNER_NOT_AUTHORIZED', false);
    }
    if (facts.assignerScope === 'MEETING_DELEGATED') {
      if (facts.role === 'APPROVER') {
        return this.reject('ASSIGNER_NOT_AUTHORIZED', false);
      }
      if (facts.meetingScopeDelegationVerified !== true) {
        return this.reject('DECISION_FACTS_REQUIRED', false);
      }
    }
    return Object.freeze({ ok: true as const });
  }

  private reject(
    reason: AssignmentFailure,
    preventEnumeration: boolean,
  ): AssignmentFailureDecision {
    return Object.freeze({ ok: false as const, reason, preventEnumeration });
  }
}
