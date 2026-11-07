type DepartmentKind = 'TECH' | 'SALES';
type MeetingKind = DepartmentKind | 'GENERAL';
type MeetingVisibility = 'DEPARTMENT' | 'COMPANY' | 'PRIVATE';
type SystemRole = 'OWNER' | 'MANAGER' | 'MEMBER';
type DepartmentRole = 'ADMIN' | 'MEMBER';
type MeetingAccessRole = 'MEETING_ADMIN' | 'REVIEWER' | 'APPROVER' | 'VIEWER';

export type MeetingReadPurpose =
  'VIEW_METADATA' | 'VIEW_SUMMARY' | 'VIEW_RAW_TRANSCRIPT';

export interface DepartmentMembershipFacts {
  readonly departmentId: string;
  readonly role: string;
  readonly status: string;
}

export interface MeetingAccessFacts {
  readonly meetingId: string;
  readonly role: string;
  readonly canReadTranscript: boolean;
}

export interface MeetingActorFacts {
  readonly systemRole: string;
  readonly isActive: boolean;
  readonly departmentMemberships: ReadonlyArray<DepartmentMembershipFacts>;
  readonly meetingAccess: ReadonlyArray<MeetingAccessFacts>;
}

export interface MeetingReadModelFacts {
  readonly id: string;
  readonly kind: string;
  readonly departmentId: string | null;
  readonly visibility: string;
}

type VisibilityFailure =
  | 'INVALID_PURPOSE'
  | 'INVALID_MEETING_SHAPE'
  | 'UNKNOWN_ACTOR'
  | 'ACTOR_NOT_ACTIVE'
  | 'INVALID_DEPARTMENT_MEMBERSHIP'
  | 'INVALID_MEETING_ACCESS'
  | 'DEPARTMENT_MEMBERSHIP_REQUIRED'
  | 'PRIVATE_ACCESS_REQUIRED'
  | 'EXPLICIT_MEETING_GRANT_REQUIRED'
  | 'EXPLICIT_TRANSCRIPT_GRANT_REQUIRED';

export type MeetingVisibilityDecision =
  | Readonly<{ allowed: true; purpose: MeetingReadPurpose }>
  | Readonly<{ allowed: false; reason: VisibilityFailure }>;

const MEETING_KINDS: Readonly<MeetingKind[]> = ['TECH', 'SALES', 'GENERAL'];
const MEETING_VISIBILITIES: Readonly<MeetingVisibility[]> = [
  'DEPARTMENT',
  'COMPANY',
  'PRIVATE',
];
const SYSTEM_AUTHORITY_ROLES: Readonly<SystemRole[]> = ['OWNER', 'MANAGER'];
const DEPARTMENT_ROLES: Readonly<DepartmentRole[]> = ['ADMIN', 'MEMBER'];
const MEETING_ACCESS_ROLES: Readonly<MeetingAccessRole[]> = [
  'MEETING_ADMIN',
  'REVIEWER',
  'APPROVER',
  'VIEWER',
];
const READ_PURPOSES: Readonly<MeetingReadPurpose[]> = [
  'VIEW_METADATA',
  'VIEW_SUMMARY',
  'VIEW_RAW_TRANSCRIPT',
];

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isReadPurpose(value: string): value is MeetingReadPurpose {
  return READ_PURPOSES.indexOf(value as MeetingReadPurpose) !== -1;
}

export class MeetingVisibilityPolicy {
  evaluate(
    actor: MeetingActorFacts,
    meeting: MeetingReadModelFacts,
    purpose: string,
  ): MeetingVisibilityDecision {
    if (!isReadPurpose(purpose)) {
      return this.reject('INVALID_PURPOSE');
    }
    const shapeFailure = this.meetingShapeFailure(meeting);
    if (shapeFailure !== null) {
      return this.reject(shapeFailure);
    }
    const actorFailure = this.actorShapeFailure(actor);
    if (actorFailure !== null) {
      return this.reject(actorFailure);
    }
    if (!actor.isActive) {
      return this.reject('ACTOR_NOT_ACTIVE');
    }

    const accessFailure = this.meetingAccessShapeFailure(
      meeting,
      actor.meetingAccess,
    );
    if (accessFailure !== null) {
      return this.reject(accessFailure);
    }
    const hasTranscriptGrant = actor.meetingAccess.some(
      (access) => access.canReadTranscript === true,
    );
    const hasExplicitMeetingGrant = actor.meetingAccess.length > 0;

    if (purpose === 'VIEW_RAW_TRANSCRIPT') {
      if (!hasTranscriptGrant) {
        return this.reject('EXPLICIT_TRANSCRIPT_GRANT_REQUIRED');
      }
      return this.approve(purpose);
    }

    const visibility = meeting.visibility as MeetingVisibility;

    if (visibility === 'COMPANY') {
      return this.approve(purpose);
    }
    if (visibility === 'DEPARTMENT') {
      const departmentFailure = this.departmentReadOutcome(actor, meeting);
      if (departmentFailure !== null) {
        return this.reject(departmentFailure);
      }
      return this.approve(purpose);
    }

    const meetingDepartmentAdmin = this.actorIsMeetingDepartmentAdmin(
      actor,
      meeting,
    );
    const canReadPrivateMetadata =
      SYSTEM_AUTHORITY_ROLES.indexOf(actor.systemRole as SystemRole) !== -1 ||
      meetingDepartmentAdmin ||
      hasExplicitMeetingGrant;
    if (purpose === 'VIEW_METADATA') {
      if (!canReadPrivateMetadata) {
        return this.reject('PRIVATE_ACCESS_REQUIRED');
      }
      return this.approve(purpose);
    }
    if (!hasExplicitMeetingGrant) {
      return this.reject('EXPLICIT_MEETING_GRANT_REQUIRED');
    }
    return this.approve(purpose);
  }

  private departmentReadOutcome(
    actor: MeetingActorFacts,
    meeting: MeetingReadModelFacts,
  ): VisibilityFailure | null {
    if (SYSTEM_AUTHORITY_ROLES.indexOf(actor.systemRole as SystemRole) !== -1) {
      return null;
    }
    if (this.actorIsDepartmentMember(actor, meeting.departmentId)) {
      return null;
    }
    if (actor.meetingAccess.length > 0) {
      return null;
    }
    return 'DEPARTMENT_MEMBERSHIP_REQUIRED';
  }

  private actorIsDepartmentMember(
    actor: MeetingActorFacts,
    departmentId: string | null,
  ): boolean {
    return (
      departmentId !== null &&
      actor.departmentMemberships.some(
        (membership) =>
          membership.departmentId === departmentId &&
          membership.status === 'ACTIVE',
      )
    );
  }

  private actorIsMeetingDepartmentAdmin(
    actor: MeetingActorFacts,
    meeting: MeetingReadModelFacts,
  ): boolean {
    return (
      meeting.departmentId !== null &&
      actor.departmentMemberships.some(
        (membership) =>
          membership.departmentId === meeting.departmentId &&
          membership.role === 'ADMIN' &&
          membership.status === 'ACTIVE',
      )
    );
  }

  private meetingShapeFailure(
    meeting: MeetingReadModelFacts,
  ): VisibilityFailure | null {
    if (
      meeting === null ||
      typeof meeting !== 'object' ||
      MEETING_KINDS.indexOf(meeting.kind as MeetingKind) === -1 ||
      MEETING_VISIBILITIES.indexOf(meeting.visibility as MeetingVisibility) ===
        -1
    ) {
      return 'INVALID_MEETING_SHAPE';
    }
    if (meeting.kind === 'GENERAL' && meeting.departmentId !== null) {
      return 'INVALID_MEETING_SHAPE';
    }
    if (
      meeting.kind !== 'GENERAL' &&
      !isNonEmptyTrimmedString(meeting.departmentId)
    ) {
      return 'INVALID_MEETING_SHAPE';
    }
    if (meeting.visibility === 'COMPANY' && meeting.kind !== 'GENERAL') {
      return 'INVALID_MEETING_SHAPE';
    }
    if (meeting.visibility === 'DEPARTMENT' && meeting.kind === 'GENERAL') {
      return 'INVALID_MEETING_SHAPE';
    }
    return null;
  }

  private actorShapeFailure(
    actor: MeetingActorFacts,
  ): VisibilityFailure | null {
    if (actor === null || typeof actor !== 'object') {
      return 'UNKNOWN_ACTOR';
    }
    if (
      typeof actor.systemRole !== 'string' ||
      (actor.systemRole !== 'OWNER' &&
        actor.systemRole !== 'MANAGER' &&
        actor.systemRole !== 'MEMBER')
    ) {
      return 'UNKNOWN_ACTOR';
    }
    if (!isBoolean(actor.isActive)) {
      return 'UNKNOWN_ACTOR';
    }
    if (!Array.isArray(actor.departmentMemberships)) {
      return 'UNKNOWN_ACTOR';
    }
    if (!Array.isArray(actor.meetingAccess)) {
      return 'UNKNOWN_ACTOR';
    }
    return this.membershipShapeFailure(actor.departmentMemberships);
  }
  private membershipShapeFailure(
    memberships: ReadonlyArray<DepartmentMembershipFacts>,
  ): VisibilityFailure | null {
    const seen = new Set<string>();
    for (const membership of memberships) {
      if (
        membership === null ||
        typeof membership !== 'object' ||
        !isNonEmptyTrimmedString(membership.departmentId) ||
        DEPARTMENT_ROLES.indexOf(membership.role as DepartmentRole) === -1 ||
        !isNonEmptyTrimmedString(membership.status)
      ) {
        return 'INVALID_DEPARTMENT_MEMBERSHIP';
      }
      if (seen.has(membership.departmentId)) {
        return 'INVALID_DEPARTMENT_MEMBERSHIP';
      }
      seen.add(membership.departmentId);
    }
    return null;
  }

  private meetingAccessShapeFailure(
    meeting: MeetingReadModelFacts,
    meetingAccess: ReadonlyArray<MeetingAccessFacts>,
  ): VisibilityFailure | null {
    const seen = new Set<string>();
    for (const access of meetingAccess) {
      if (
        access === null ||
        typeof access !== 'object' ||
        MEETING_ACCESS_ROLES.indexOf(access.role as MeetingAccessRole) === -1 ||
        !isBoolean(access.canReadTranscript) ||
        !isNonEmptyTrimmedString(access.meetingId) ||
        access.meetingId !== meeting.id
      ) {
        return 'INVALID_MEETING_ACCESS';
      }

      if (seen.has(access.meetingId)) {
        return 'INVALID_MEETING_ACCESS';
      }
      seen.add(access.meetingId);
    }
    return null;
  }

  private approve(purpose: MeetingReadPurpose): MeetingVisibilityDecision {
    return Object.freeze({ allowed: true as const, purpose });
  }

  private reject(reason: VisibilityFailure): MeetingVisibilityDecision {
    return Object.freeze({ allowed: false as const, reason });
  }
}
