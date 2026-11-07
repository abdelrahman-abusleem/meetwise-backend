export interface ScheduledJoinJob {
  readonly occurrenceId: string;
  readonly scheduleVersion: number;
}

export interface ScheduledOccurrenceFacts {
  readonly id: string;
  readonly kind: string;
  readonly departmentId: string | null;
  readonly lifecycle: string;
  readonly scheduleVersion: number;
  readonly scheduledAt: number;
}

export interface DispatchDepartmentFacts {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
}

export interface CaptureReadinessFacts {
  readonly supportedMeetLink: boolean;
  readonly providerEnabled: boolean;
  readonly providerConfigurationValid: boolean;
  readonly capturePolicy: 'PERMITTED' | 'DENIED' | 'UNRESOLVED';
}

type IneligibilityReason =
  | 'STALE_JOB'
  | 'INELIGIBLE_LIFECYCLE'
  | 'INVALID_TIME'
  | 'NOT_DUE'
  | 'INELIGIBLE_DEPARTMENT'
  | 'CAPTURE_NOT_READY';

export type ScheduledJoinDecision =
  | Readonly<{ eligible: true; occurrenceId: string; scheduleVersion: number }>
  | Readonly<{ eligible: false; reason: IneligibilityReason }>;

export class ScheduledJoinEligibilityPolicy {
  evaluate(
    job: ScheduledJoinJob,
    occurrence: ScheduledOccurrenceFacts,
    department: DispatchDepartmentFacts | null,
    readiness: CaptureReadinessFacts,
    now: number,
  ): ScheduledJoinDecision {
    if (
      typeof job.occurrenceId !== 'string' ||
      job.occurrenceId.trim() === '' ||
      job.occurrenceId !== occurrence.id ||
      !Number.isSafeInteger(job.scheduleVersion) ||
      job.scheduleVersion < 0 ||
      !Number.isSafeInteger(occurrence.scheduleVersion) ||
      job.scheduleVersion !== occurrence.scheduleVersion
    ) {
      return this.reject('STALE_JOB');
    }
    if (occurrence.lifecycle !== 'SCHEDULED') {
      return this.reject('INELIGIBLE_LIFECYCLE');
    }
    if (!Number.isFinite(now) || !Number.isFinite(occurrence.scheduledAt)) {
      return this.reject('INVALID_TIME');
    }
    if (occurrence.scheduledAt > now) {
      return this.reject('NOT_DUE');
    }
    if (!this.departmentEligible(occurrence, department)) {
      return this.reject('INELIGIBLE_DEPARTMENT');
    }
    if (
      readiness.supportedMeetLink !== true ||
      readiness.providerEnabled !== true ||
      readiness.providerConfigurationValid !== true ||
      readiness.capturePolicy !== 'PERMITTED'
    ) {
      return this.reject('CAPTURE_NOT_READY');
    }
    return Object.freeze({
      eligible: true,
      occurrenceId: occurrence.id,
      scheduleVersion: occurrence.scheduleVersion,
    });
  }

  private departmentEligible(
    occurrence: ScheduledOccurrenceFacts,
    department: DispatchDepartmentFacts | null,
  ): boolean {
    if (occurrence.kind === 'GENERAL') {
      return occurrence.departmentId === null && department === null;
    }
    return (
      (occurrence.kind === 'TECH' || occurrence.kind === 'SALES') &&
      typeof occurrence.departmentId === 'string' &&
      occurrence.departmentId.trim() !== '' &&
      department !== null &&
      department.id === occurrence.departmentId &&
      department.kind === occurrence.kind &&
      department.status === 'ACTIVE'
    );
  }

  private reject(reason: IneligibilityReason): ScheduledJoinDecision {
    return Object.freeze({ eligible: false, reason });
  }
}
