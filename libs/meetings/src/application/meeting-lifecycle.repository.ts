export type MeetingLifecycleVocabulary =
  'DRAFT' | 'SCHEDULED' | 'IN_PROGRESS' | 'ENDED' | 'CANCELLED';

export type MeetingLifecycleCommandVocabulary =
  | 'SCHEDULE'
  | 'RESCHEDULE'
  | 'START_CAPTURE'
  | 'CAPTURE_ENDED'
  | 'MANUAL_END'
  | 'ADMIN_STOP'
  | 'ADMIN_CANCEL';

export interface MeetingLifecycleRecord {
  readonly meetingId: string;
  readonly meetingKind: string;
  readonly departmentId: string | null;
  readonly lifecycleStatus: MeetingLifecycleVocabulary;
  readonly scheduleVersion: number;
  readonly meetUrl: string | null;
  readonly scheduledAtUtc: string | null;
  readonly captureStatus: string;
  readonly createdById: string;
  readonly meetingAdminId: string | null;
}

export type MeetingLifecycleRefusalLabel =
  'GONE' | 'STATE_DIVERGED' | 'VERSION_MISMATCH' | 'ACTIVE_CAPTURE_CONFLICT';

export type ApplyLifecycleTransitionResult =
  | Readonly<{ ok: true; meeting: MeetingLifecycleRecord }>
  | Readonly<{
      ok: false;
      label: MeetingLifecycleRefusalLabel;
      currentLifecycle?: MeetingLifecycleVocabulary;
      currentScheduleVersion?: number;
    }>;

export interface ApplyLifecycleTransitionCommand {
  readonly command: MeetingLifecycleCommandVocabulary;
  readonly expectedLifecycle: MeetingLifecycleVocabulary;
  readonly targetLifecycle: MeetingLifecycleVocabulary;
  readonly expectedScheduleVersion: number;
  readonly bumpScheduleVersion: boolean;
  readonly newScheduledAtUtc?: string | null | undefined;
  readonly newMeetUrl?: string | null | undefined;
  readonly transitionReason?: string | undefined;
  readonly actorUserId?: string | undefined;
}

export interface MeetingLifecycleRepository {
  loadMeetingRecord(meetingId: string): Promise<MeetingLifecycleRecord | null>;

  applyTransition(
    meetingId: string,
    command: ApplyLifecycleTransitionCommand,
  ): Promise<ApplyLifecycleTransitionResult>;
}
