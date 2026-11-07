export type EligibilityFailure =
  | 'INVALID_REQUEST'
  | 'DECISION_FACTS_REQUIRED'
  | 'UNKNOWN_MEETING_KIND'
  | 'UNKNOWN_LIFECYCLE'
  | 'UNKNOWN_DEPARTMENT_STATE'
  | 'MEETING_NOT_JOINABLE'
  | 'STALE_JOB'
  | 'MEETING_NOT_DUE'
  | 'UNSUPPORTED_MEETING_URL'
  | 'DEPARTMENT_NOT_ACTIVE'
  | 'PROVIDER_NOT_READY';

export type JoinEligibilityDecision = Readonly<{
  ok: boolean;
  reason?: EligibilityFailure;
  preventEnumeration?: boolean;
}>;

const MEETING_KINDS: Readonly<string[]> = Object.freeze([
  'TECH',
  'SALES',
  'GENERAL',
]);

const MEETING_LIFECYCLE: Readonly<string[]> = Object.freeze([
  'DRAFT',
  'SCHEDULED',
  'IN_PROGRESS',
  'ENDED',
  'CANCELLED',
]);

const DEPARTMENT_STATES: Readonly<string[]> = Object.freeze([
  'ACTIVE',
  'CONFIGURING',
  'DISABLED',
  'SUSPENDED',
]);

const MEET_HOST_PREFIX = 'https://meet.google.com/';

const ISO_8601_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export class BotJoinEligibilityPolicy {
  evaluate(request: unknown): JoinEligibilityDecision {
    if (request === null || typeof request !== 'object') {
      return this.reject('INVALID_REQUEST');
    }
    const facts = request as {
      meetingId?: unknown;
      meetingKind?: unknown;
      meetingLifecycle?: unknown;
      occurrenceStartAt?: unknown;
      dispatchAt?: unknown;
      staleJob?: unknown;
      scheduleVersionExpected?: unknown;
      scheduleVersionCurrent?: unknown;
      meetUrl?: unknown;
      departmentActivationState?: unknown;
      providerConnectionAuthorized?: unknown;
      providerConfigEnabled?: unknown;
      capturePrerequisitesVerified?: unknown;
    };
    if (typeof facts.meetingId !== 'string' || facts.meetingId.trim() === '') {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (
      typeof facts.meetingKind !== 'string' ||
      facts.meetingKind.trim() === ''
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (MEETING_KINDS.indexOf(facts.meetingKind) === -1) {
      return this.reject('UNKNOWN_MEETING_KIND');
    }
    if (
      typeof facts.meetingLifecycle !== 'string' ||
      facts.meetingLifecycle.trim() === ''
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (MEETING_LIFECYCLE.indexOf(facts.meetingLifecycle) === -1) {
      return this.reject('UNKNOWN_LIFECYCLE');
    }
    if (typeof facts.meetUrl !== 'string' || facts.meetUrl.trim() === '') {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (
      typeof facts.providerConnectionAuthorized !== 'boolean' ||
      typeof facts.providerConfigEnabled !== 'boolean' ||
      typeof facts.capturePrerequisitesVerified !== 'boolean' ||
      typeof facts.staleJob !== 'boolean'
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    const versionPair = this.checkVersionPair([
      facts.scheduleVersionExpected,
      facts.scheduleVersionCurrent,
    ]);
    if (versionPair !== null) {
      return this.reject(versionPair);
    }
    const departmentState = this.checkDepartmentActivation(
      facts.meetingKind,
      facts.departmentActivationState,
    );
    if (departmentState !== null) {
      return this.reject(departmentState);
    }

    if (facts.staleJob !== false) {
      return this.reject('STALE_JOB');
    }

    if (facts.meetingLifecycle !== 'SCHEDULED') {
      return this.reject('MEETING_NOT_JOINABLE');
    }

    if (facts.scheduleVersionExpected !== facts.scheduleVersionCurrent) {
      return this.reject('STALE_JOB');
    }

    const startAt = facts.occurrenceStartAt;
    const dispatchAt = facts.dispatchAt;
    if (
      typeof startAt !== 'string' ||
      typeof dispatchAt !== 'string' ||
      !ISO_8601_INSTANT.test(startAt) ||
      !ISO_8601_INSTANT.test(dispatchAt)
    ) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    const startMs = Date.parse(startAt);
    const dispatchMs = Date.parse(dispatchAt);
    if (Number.isNaN(startMs) || Number.isNaN(dispatchMs)) {
      return this.reject('DECISION_FACTS_REQUIRED');
    }
    if (startMs > dispatchMs) {
      return this.reject('MEETING_NOT_DUE');
    }

    if (!facts.meetUrl.startsWith(MEET_HOST_PREFIX)) {
      return this.reject('UNSUPPORTED_MEETING_URL');
    }
    if (facts.meetUrl.slice(MEET_HOST_PREFIX.length).trim() === '') {
      return this.reject('UNSUPPORTED_MEETING_URL');
    }

    if (facts.meetingKind !== 'GENERAL') {
      if (facts.departmentActivationState !== 'ACTIVE') {
        return this.reject('DEPARTMENT_NOT_ACTIVE');
      }
    }

    if (!(facts.providerConnectionAuthorized && facts.providerConfigEnabled)) {
      return this.reject('PROVIDER_NOT_READY');
    }

    if (!facts.capturePrerequisitesVerified) {
      return this.reject('PROVIDER_NOT_READY');
    }
    return Object.freeze({ ok: true as const });
  }

  private checkVersionPair(
    pair: [unknown, unknown],
  ): Extract<
    EligibilityFailure,
    'DECISION_FACTS_REQUIRED' | 'STALE_JOB'
  > | null {
    for (const value of pair) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        return 'DECISION_FACTS_REQUIRED';
      }
    }
    return null;
  }

  private checkDepartmentActivation(
    meetingKind: string,
    departmentActivationState: unknown,
  ): Extract<
    EligibilityFailure,
    'DECISION_FACTS_REQUIRED' | 'UNKNOWN_DEPARTMENT_STATE'
  > | null {
    if (meetingKind === 'GENERAL') {
      if (
        departmentActivationState !== undefined &&
        departmentActivationState !== null
      ) {
        return 'DECISION_FACTS_REQUIRED';
      }
      return null;
    }
    if (
      departmentActivationState === undefined ||
      departmentActivationState === null
    ) {
      return 'DECISION_FACTS_REQUIRED';
    }
    if (
      typeof departmentActivationState !== 'string' ||
      DEPARTMENT_STATES.indexOf(departmentActivationState) === -1
    ) {
      return 'UNKNOWN_DEPARTMENT_STATE';
    }
    return null;
  }

  private reject(reason: EligibilityFailure): JoinEligibilityDecision {
    return Object.freeze({
      ok: false as const,
      reason: reason,
      preventEnumeration: false as const,
    });
  }
}
