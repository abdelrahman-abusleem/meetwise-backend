import type { MeetingScope } from './meeting-scope.policy.js';

export interface MeetingUserFacts {
  readonly id: string;
  readonly role: string;
  readonly isActive: boolean;
}

export interface MeetingMembershipFacts {
  readonly userId: string;
  readonly departmentId: string;
  readonly role: string;
  readonly canCreateMeetings: boolean;
  readonly canManageMeetings: boolean;
}

export interface MeetingManagerCandidate {
  readonly user: MeetingUserFacts;
  readonly membership: MeetingMembershipFacts | null;
}

type CreationFailure =
  | 'CREATION_FORBIDDEN'
  | 'PRIVATE_VISIBILITY_FORBIDDEN'
  | 'ELIGIBLE_MANAGER_REQUIRED'
  | 'MANAGER_SELECTION_NOT_PERMITTED';

export type MeetingCreationDecision =
  | Readonly<{ ok: true; createdById: string; meetingAdminId: string }>
  | Readonly<{ ok: false; reason: CreationFailure }>;

export class MeetingCreationPolicy {
  decide(
    scope: Readonly<MeetingScope>,
    creator: MeetingUserFacts,
    membership: MeetingMembershipFacts | null = null,
    selectedManager: MeetingManagerCandidate | null = null,
  ): MeetingCreationDecision {
    if (!this.mayCreate(scope, creator, membership)) {
      return this.reject('CREATION_FORBIDDEN');
    }

    const creatorMayManage = this.mayManage(scope, creator, membership);
    if (scope.visibility === 'PRIVATE' && !creatorMayManage) {
      return this.reject('PRIVATE_VISIBILITY_FORBIDDEN');
    }

    if (creatorMayManage) {
      if (selectedManager !== null && selectedManager.user.id !== creator.id) {
        return this.reject('MANAGER_SELECTION_NOT_PERMITTED');
      }
      return this.accept(creator.id, creator.id);
    }

    if (
      selectedManager === null ||
      selectedManager.user.id === creator.id ||
      !this.mayManage(scope, selectedManager.user, selectedManager.membership)
    ) {
      return this.reject('ELIGIBLE_MANAGER_REQUIRED');
    }
    return this.accept(creator.id, selectedManager.user.id);
  }

  private mayCreate(
    scope: Readonly<MeetingScope>,
    user: MeetingUserFacts,
    membership: MeetingMembershipFacts | null,
  ): boolean {
    if (!this.isActiveUser(user)) return false;
    if (this.isSystemManager(user)) return true;
    if (!this.hasScopedMembership(scope, user, membership)) return false;
    return membership.role === 'ADMIN' || membership.canCreateMeetings === true;
  }

  private mayManage(
    scope: Readonly<MeetingScope>,
    user: MeetingUserFacts,
    membership: MeetingMembershipFacts | null,
  ): boolean {
    if (!this.isActiveUser(user)) return false;
    if (this.isSystemManager(user)) return true;
    if (!this.hasScopedMembership(scope, user, membership)) return false;
    return membership.role === 'ADMIN' || membership.canManageMeetings === true;
  }

  private isActiveUser(user: MeetingUserFacts): boolean {
    return (
      user.isActive === true &&
      typeof user.id === 'string' &&
      user.id.trim() !== ''
    );
  }

  private isSystemManager(user: MeetingUserFacts): boolean {
    return user.role === 'OWNER' || user.role === 'MANAGER';
  }

  private hasScopedMembership(
    scope: Readonly<MeetingScope>,
    user: MeetingUserFacts,
    membership: MeetingMembershipFacts | null,
  ): membership is MeetingMembershipFacts {
    return (
      scope.kind !== 'GENERAL' &&
      user.role === 'MEMBER' &&
      membership !== null &&
      membership.userId === user.id &&
      membership.departmentId === scope.departmentId &&
      (membership.role === 'ADMIN' || membership.role === 'MEMBER')
    );
  }

  private accept(
    createdById: string,
    meetingAdminId: string,
  ): MeetingCreationDecision {
    return Object.freeze({ ok: true, createdById, meetingAdminId });
  }

  private reject(reason: CreationFailure): MeetingCreationDecision {
    return Object.freeze({ ok: false, reason });
  }
}
