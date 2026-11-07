import { MeetingLifecyclePolicy } from '../domain/meeting-lifecycle.policy';
import type {
  MeetingLifecycleVocabulary,
  MeetingLifecycleCommandVocabulary,
  MeetingLifecycleRecord,
  MeetingLifecycleRefusalLabel,
  MeetingLifecycleRepository,
  ApplyLifecycleTransitionCommand,
  ApplyLifecycleTransitionResult,
} from './meeting-lifecycle.repository';

export type SystemRoleVocabulary = 'OWNER' | 'MANAGER' | 'MEMBER';
export type DepartmentRoleVocabulary = 'ADMIN' | 'MEMBER';
export type MeetingRoleVocabulary =
  'MEETING_ADMIN' | 'REVIEWER' | 'APPROVER' | 'VIEWER';

export interface MeetingLifecycleActor {
  readonly userId: string;
  readonly systemRole: SystemRoleVocabulary;
  readonly departmentId?: string | null | undefined;
  readonly departmentRole?: DepartmentRoleVocabulary | null | undefined;
  readonly meetingRole?: MeetingRoleVocabulary | null | undefined;
}

export interface ScheduleMeetingRequest {
  readonly actor: MeetingLifecycleActor;
  readonly scheduledAtUtc: string;
  readonly meetUrl: string;
}

export interface RescheduleMeetingRequest {
  readonly actor: MeetingLifecycleActor;
  readonly scheduledAtUtc: string;
  readonly meetUrl?: string | null | undefined;
}

export interface StartCaptureRequest {
  readonly claimedScheduleVersion: number;
  readonly actor?: MeetingLifecycleActor | undefined;
  readonly systemAuthorized?: boolean | undefined;
}

export interface EndCaptureRequest {
  readonly actor?: MeetingLifecycleActor | undefined;
  readonly systemAuthorized?: boolean | undefined;
}

export interface ManualEndMeetingRequest {
  readonly actor: MeetingLifecycleActor;
}

export interface AdminStopMeetingRequest {
  readonly actor: MeetingLifecycleActor;
  readonly reason: string;
}

export interface AdminCancelMeetingRequest {
  readonly actor: MeetingLifecycleActor;
  readonly reason: string;
}

export type MeetingLifecycleServiceOutcome =
  | Readonly<{
      kind: 'TRANSITIONED';
      command: MeetingLifecycleCommandVocabulary;
      from: MeetingLifecycleVocabulary;
      to: MeetingLifecycleVocabulary;
      meeting: MeetingLifecycleRecord;
      stopCapture: boolean;
      preservePartialEvidence: boolean;
      invalidateStaleJobs: boolean;
    }>
  | Readonly<{
      kind: 'REFUSED';
      policyReason: string;
    }>
  | Readonly<{
      kind: 'REFUSED_DOWNSTREAM';
      label: MeetingLifecycleRefusalLabel | 'UNAUTHORIZED';
    }>;

const ISO_8601_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const MEET_HOST_PREFIX = 'https://meet.google.com/';

export class MeetingLifecycleService {
  private readonly repository: MeetingLifecycleRepository;
  private readonly policy: MeetingLifecyclePolicy;

  constructor(
    repository: MeetingLifecycleRepository,
    policy?: MeetingLifecyclePolicy,
  ) {
    this.repository = repository;
    this.policy = policy ?? new MeetingLifecyclePolicy();
  }

  async schedule(
    meetingId: string,
    request: Readonly<ScheduleMeetingRequest>,
  ): Promise<MeetingLifecycleServiceOutcome> {
    this.assertMeetingId(meetingId);
    if (request === null || typeof request !== 'object') {
      throw new Error('meeting-lifecycle-invalid-request');
    }
    this.assertActorShape(request.actor);
    this.assertInstant(request.scheduledAtUtc);
    this.assertMeetUrl(request.meetUrl);

    const meeting = await this.repository.loadMeetingRecord(meetingId);
    if (meeting === null) {
      throw new Error('meeting-lifecycle-race-lost');
    }
    this.assertRecordIntegrity(meeting, meetingId);

    const isAuthorized = this.isActorAuthorizedForManage(
      request.actor,
      meeting,
    );
    if (!isAuthorized) {
      return { kind: 'REFUSED_DOWNSTREAM', label: 'UNAUTHORIZED' };
    }

    const decision = this.policy.evaluate({
      command: 'SCHEDULE',
      currentLifecycle: meeting.lifecycleStatus,
      currentScheduleVersion: meeting.scheduleVersion,
      authorized: true,
    });
    if (!decision.ok) {
      return { kind: 'REFUSED', policyReason: decision.reason };
    }

    const applied = await this.applyCheckedTransition(meetingId, {
      command: 'SCHEDULE',
      expectedLifecycle: meeting.lifecycleStatus,
      targetLifecycle: decision.to,
      expectedScheduleVersion: meeting.scheduleVersion,
      bumpScheduleVersion: true,
      newScheduledAtUtc: request.scheduledAtUtc,
      newMeetUrl: request.meetUrl,
      actorUserId: request.actor.userId,
    });
    if (!applied.ok) {
      return { kind: 'REFUSED_DOWNSTREAM', label: applied.label };
    }

    return {
      kind: 'TRANSITIONED',
      command: 'SCHEDULE',
      from: decision.from,
      to: decision.to,
      meeting: applied.meeting,
      stopCapture: decision.stopCapture,
      preservePartialEvidence: decision.preservePartialEvidence,
      invalidateStaleJobs: decision.invalidateStaleJobs,
    };
  }

  async reschedule(
    meetingId: string,
    request: Readonly<RescheduleMeetingRequest>,
  ): Promise<MeetingLifecycleServiceOutcome> {
    this.assertMeetingId(meetingId);
    if (request === null || typeof request !== 'object') {
      throw new Error('meeting-lifecycle-invalid-request');
    }
    this.assertActorShape(request.actor);
    this.assertInstant(request.scheduledAtUtc);
    if (
      request.meetUrl !== undefined &&
      request.meetUrl !== null &&
      request.meetUrl !== ''
    ) {
      this.assertMeetUrl(request.meetUrl);
    }

    const meeting = await this.repository.loadMeetingRecord(meetingId);
    if (meeting === null) {
      throw new Error('meeting-lifecycle-race-lost');
    }
    this.assertRecordIntegrity(meeting, meetingId);

    const isAuthorized = this.isActorAuthorizedForManage(
      request.actor,
      meeting,
    );
    if (!isAuthorized) {
      return { kind: 'REFUSED_DOWNSTREAM', label: 'UNAUTHORIZED' };
    }

    const decision = this.policy.evaluate({
      command: 'RESCHEDULE',
      currentLifecycle: meeting.lifecycleStatus,
      currentScheduleVersion: meeting.scheduleVersion,
      authorized: true,
    });
    if (!decision.ok) {
      return { kind: 'REFUSED', policyReason: decision.reason };
    }

    const applied = await this.applyCheckedTransition(meetingId, {
      command: 'RESCHEDULE',
      expectedLifecycle: meeting.lifecycleStatus,
      targetLifecycle: decision.to,
      expectedScheduleVersion: meeting.scheduleVersion,
      bumpScheduleVersion: true,
      newScheduledAtUtc: request.scheduledAtUtc,
      newMeetUrl: request.meetUrl ?? meeting.meetUrl,
      actorUserId: request.actor.userId,
    });
    if (!applied.ok) {
      return { kind: 'REFUSED_DOWNSTREAM', label: applied.label };
    }

    return {
      kind: 'TRANSITIONED',
      command: 'RESCHEDULE',
      from: decision.from,
      to: decision.to,
      meeting: applied.meeting,
      stopCapture: decision.stopCapture,
      preservePartialEvidence: decision.preservePartialEvidence,
      invalidateStaleJobs: decision.invalidateStaleJobs,
    };
  }

  async startCapture(
    meetingId: string,
    request: Readonly<StartCaptureRequest>,
  ): Promise<MeetingLifecycleServiceOutcome> {
    this.assertMeetingId(meetingId);
    if (
      request === null ||
      typeof request !== 'object' ||
      typeof request.claimedScheduleVersion !== 'number' ||
      !Number.isInteger(request.claimedScheduleVersion) ||
      request.claimedScheduleVersion < 0
    ) {
      throw new Error('meeting-lifecycle-invalid-request');
    }
    if (request.actor !== undefined) this.assertActorShape(request.actor);

    const meeting = await this.repository.loadMeetingRecord(meetingId);
    if (meeting === null) {
      throw new Error('meeting-lifecycle-race-lost');
    }
    this.assertRecordIntegrity(meeting, meetingId);

    const isAuthorized =
      request.systemAuthorized === true ||
      (request.actor !== undefined &&
        (request.actor.systemRole === 'OWNER' ||
          request.actor.systemRole === 'MANAGER'));
    if (!isAuthorized) {
      return { kind: 'REFUSED_DOWNSTREAM', label: 'UNAUTHORIZED' };
    }

    const decision = this.policy.evaluate({
      command: 'START_CAPTURE',
      currentLifecycle: meeting.lifecycleStatus,
      currentScheduleVersion: meeting.scheduleVersion,
      claimedScheduleVersion: request.claimedScheduleVersion,
      authorized: true,
    });
    if (!decision.ok) {
      return { kind: 'REFUSED', policyReason: decision.reason };
    }

    const applied = await this.applyCheckedTransition(meetingId, {
      command: 'START_CAPTURE',
      expectedLifecycle: meeting.lifecycleStatus,
      targetLifecycle: decision.to,
      expectedScheduleVersion: meeting.scheduleVersion,
      bumpScheduleVersion: false,
    });
    if (!applied.ok) {
      return { kind: 'REFUSED_DOWNSTREAM', label: applied.label };
    }

    return {
      kind: 'TRANSITIONED',
      command: 'START_CAPTURE',
      from: decision.from,
      to: decision.to,
      meeting: applied.meeting,
      stopCapture: decision.stopCapture,
      preservePartialEvidence: decision.preservePartialEvidence,
      invalidateStaleJobs: decision.invalidateStaleJobs,
    };
  }

  async endCapture(
    meetingId: string,
    request: Readonly<EndCaptureRequest>,
  ): Promise<MeetingLifecycleServiceOutcome> {
    this.assertMeetingId(meetingId);
    if (request === null || typeof request !== 'object') {
      throw new Error('meeting-lifecycle-invalid-request');
    }
    if (request.actor !== undefined) this.assertActorShape(request.actor);

    const meeting = await this.repository.loadMeetingRecord(meetingId);
    if (meeting === null) {
      throw new Error('meeting-lifecycle-race-lost');
    }
    this.assertRecordIntegrity(meeting, meetingId);

    const isAuthorized =
      request.systemAuthorized === true ||
      (request.actor !== undefined &&
        (request.actor.systemRole === 'OWNER' ||
          request.actor.systemRole === 'MANAGER'));
    if (!isAuthorized) {
      return { kind: 'REFUSED_DOWNSTREAM', label: 'UNAUTHORIZED' };
    }

    const decision = this.policy.evaluate({
      command: 'CAPTURE_ENDED',
      currentLifecycle: meeting.lifecycleStatus,
      currentScheduleVersion: meeting.scheduleVersion,
      authorized: true,
    });
    if (!decision.ok) {
      return { kind: 'REFUSED', policyReason: decision.reason };
    }

    const applied = await this.applyCheckedTransition(meetingId, {
      command: 'CAPTURE_ENDED',
      expectedLifecycle: meeting.lifecycleStatus,
      targetLifecycle: decision.to,
      expectedScheduleVersion: meeting.scheduleVersion,
      bumpScheduleVersion: false,
    });
    if (!applied.ok) {
      return { kind: 'REFUSED_DOWNSTREAM', label: applied.label };
    }

    return {
      kind: 'TRANSITIONED',
      command: 'CAPTURE_ENDED',
      from: decision.from,
      to: decision.to,
      meeting: applied.meeting,
      stopCapture: decision.stopCapture,
      preservePartialEvidence: decision.preservePartialEvidence,
      invalidateStaleJobs: decision.invalidateStaleJobs,
    };
  }

  async manualEnd(
    meetingId: string,
    request: Readonly<ManualEndMeetingRequest>,
  ): Promise<MeetingLifecycleServiceOutcome> {
    this.assertMeetingId(meetingId);
    if (request === null || typeof request !== 'object') {
      throw new Error('meeting-lifecycle-invalid-request');
    }
    this.assertActorShape(request.actor);

    const meeting = await this.repository.loadMeetingRecord(meetingId);
    if (meeting === null) {
      throw new Error('meeting-lifecycle-race-lost');
    }
    this.assertRecordIntegrity(meeting, meetingId);

    const isAuthorized = this.isActorAuthorizedForManage(
      request.actor,
      meeting,
    );
    if (!isAuthorized) {
      return { kind: 'REFUSED_DOWNSTREAM', label: 'UNAUTHORIZED' };
    }

    const decision = this.policy.evaluate({
      command: 'MANUAL_END',
      currentLifecycle: meeting.lifecycleStatus,
      currentScheduleVersion: meeting.scheduleVersion,
      authorized: true,
    });
    if (!decision.ok) {
      return { kind: 'REFUSED', policyReason: decision.reason };
    }

    const applied = await this.applyCheckedTransition(meetingId, {
      command: 'MANUAL_END',
      expectedLifecycle: meeting.lifecycleStatus,
      targetLifecycle: decision.to,
      expectedScheduleVersion: meeting.scheduleVersion,
      bumpScheduleVersion: false,
      actorUserId: request.actor.userId,
    });
    if (!applied.ok) {
      return { kind: 'REFUSED_DOWNSTREAM', label: applied.label };
    }

    return {
      kind: 'TRANSITIONED',
      command: 'MANUAL_END',
      from: decision.from,
      to: decision.to,
      meeting: applied.meeting,
      stopCapture: decision.stopCapture,
      preservePartialEvidence: decision.preservePartialEvidence,
      invalidateStaleJobs: decision.invalidateStaleJobs,
    };
  }

  async adminStop(
    meetingId: string,
    request: Readonly<AdminStopMeetingRequest>,
  ): Promise<MeetingLifecycleServiceOutcome> {
    this.assertMeetingId(meetingId);
    if (request === null || typeof request !== 'object') {
      throw new Error('meeting-lifecycle-invalid-request');
    }
    this.assertActorShape(request.actor);
    if (typeof request.reason !== 'string' || request.reason.trim() === '') {
      throw new Error('meeting-lifecycle-invalid-request');
    }

    const meeting = await this.repository.loadMeetingRecord(meetingId);
    if (meeting === null) {
      throw new Error('meeting-lifecycle-race-lost');
    }
    this.assertRecordIntegrity(meeting, meetingId);

    const isAuthorized = this.isActorAuthorizedForManage(
      request.actor,
      meeting,
    );
    if (!isAuthorized) {
      return { kind: 'REFUSED_DOWNSTREAM', label: 'UNAUTHORIZED' };
    }

    const decision = this.policy.evaluate({
      command: 'ADMIN_STOP',
      currentLifecycle: meeting.lifecycleStatus,
      currentScheduleVersion: meeting.scheduleVersion,
      authorized: true,
      reason: request.reason,
    });
    if (!decision.ok) {
      return { kind: 'REFUSED', policyReason: decision.reason };
    }

    const applied = await this.applyCheckedTransition(meetingId, {
      command: 'ADMIN_STOP',
      expectedLifecycle: meeting.lifecycleStatus,
      targetLifecycle: decision.to,
      expectedScheduleVersion: meeting.scheduleVersion,
      bumpScheduleVersion: false,
      transitionReason: request.reason,
      actorUserId: request.actor.userId,
    });
    if (!applied.ok) {
      return { kind: 'REFUSED_DOWNSTREAM', label: applied.label };
    }

    return {
      kind: 'TRANSITIONED',
      command: 'ADMIN_STOP',
      from: decision.from,
      to: decision.to,
      meeting: applied.meeting,
      stopCapture: decision.stopCapture,
      preservePartialEvidence: decision.preservePartialEvidence,
      invalidateStaleJobs: decision.invalidateStaleJobs,
    };
  }

  async adminCancel(
    meetingId: string,
    request: Readonly<AdminCancelMeetingRequest>,
  ): Promise<MeetingLifecycleServiceOutcome> {
    this.assertMeetingId(meetingId);
    if (request === null || typeof request !== 'object') {
      throw new Error('meeting-lifecycle-invalid-request');
    }
    this.assertActorShape(request.actor);
    if (typeof request.reason !== 'string' || request.reason.trim() === '') {
      throw new Error('meeting-lifecycle-invalid-request');
    }

    const meeting = await this.repository.loadMeetingRecord(meetingId);
    if (meeting === null) {
      throw new Error('meeting-lifecycle-race-lost');
    }
    this.assertRecordIntegrity(meeting, meetingId);

    const isAuthorized = this.isActorAuthorizedForCancel(
      request.actor,
      meeting,
    );
    if (!isAuthorized) {
      return { kind: 'REFUSED_DOWNSTREAM', label: 'UNAUTHORIZED' };
    }

    const decision = this.policy.evaluate({
      command: 'ADMIN_CANCEL',
      currentLifecycle: meeting.lifecycleStatus,
      currentScheduleVersion: meeting.scheduleVersion,
      authorized: true,
      reason: request.reason,
    });
    if (!decision.ok) {
      return { kind: 'REFUSED', policyReason: decision.reason };
    }

    const applied = await this.applyCheckedTransition(meetingId, {
      command: 'ADMIN_CANCEL',
      expectedLifecycle: meeting.lifecycleStatus,
      targetLifecycle: decision.to,
      expectedScheduleVersion: meeting.scheduleVersion,
      bumpScheduleVersion: true,
      transitionReason: request.reason,
      actorUserId: request.actor.userId,
    });
    if (!applied.ok) {
      return { kind: 'REFUSED_DOWNSTREAM', label: applied.label };
    }

    return {
      kind: 'TRANSITIONED',
      command: 'ADMIN_CANCEL',
      from: decision.from,
      to: decision.to,
      meeting: applied.meeting,
      stopCapture: decision.stopCapture,
      preservePartialEvidence: decision.preservePartialEvidence,
      invalidateStaleJobs: decision.invalidateStaleJobs,
    };
  }

  private async applyCheckedTransition(
    meetingId: string,
    command: ApplyLifecycleTransitionCommand,
  ): Promise<ApplyLifecycleTransitionResult> {
    const result = await this.repository.applyTransition(meetingId, command);
    if (result.ok === true) {
      this.assertRecordIntegrity(result.meeting, meetingId);
      const expectedVersion =
        command.expectedScheduleVersion + (command.bumpScheduleVersion ? 1 : 0);
      if (
        result.meeting.lifecycleStatus !== command.targetLifecycle ||
        result.meeting.scheduleVersion !== expectedVersion
      ) {
        throw new Error('meeting-lifecycle-row-mapping-corrupt');
      }
    } else if (result.ok !== false) {
      throw new Error('meeting-lifecycle-row-mapping-corrupt');
    }
    return result;
  }

  private isActorAuthorizedForManage(
    actor: MeetingLifecycleActor,
    meeting: MeetingLifecycleRecord,
  ): boolean {
    if (actor.systemRole === 'OWNER' || actor.systemRole === 'MANAGER') {
      return true;
    }
    if (
      actor.meetingRole === 'MEETING_ADMIN' ||
      (meeting.meetingAdminId !== null &&
        actor.userId === meeting.meetingAdminId)
    ) {
      return true;
    }
    if (
      meeting.meetingKind !== 'GENERAL' &&
      meeting.departmentId !== null &&
      actor.departmentId === meeting.departmentId &&
      actor.departmentRole === 'ADMIN'
    ) {
      return true;
    }
    return false;
  }

  private isActorAuthorizedForCancel(
    actor: MeetingLifecycleActor,
    meeting: MeetingLifecycleRecord,
  ): boolean {
    if (actor.systemRole === 'OWNER' || actor.systemRole === 'MANAGER') {
      return true;
    }
    if (
      meeting.meetingKind !== 'GENERAL' &&
      meeting.departmentId !== null &&
      actor.departmentId === meeting.departmentId &&
      actor.departmentRole === 'ADMIN'
    ) {
      return true;
    }

    if (
      actor.meetingRole === 'MEETING_ADMIN' ||
      (meeting.meetingAdminId !== null &&
        actor.userId === meeting.meetingAdminId)
    ) {
      return true;
    }
    return false;
  }

  private assertMeetingId(meetingId: string): void {
    if (typeof meetingId !== 'string' || meetingId.trim() === '') {
      throw new Error('meeting-lifecycle-invalid-request');
    }
  }

  private assertActorShape(actor: MeetingLifecycleActor): void {
    if (
      actor === null ||
      typeof actor !== 'object' ||
      typeof actor.userId !== 'string' ||
      actor.userId.trim() === '' ||
      typeof actor.systemRole !== 'string' ||
      (actor.systemRole !== 'OWNER' &&
        actor.systemRole !== 'MANAGER' &&
        actor.systemRole !== 'MEMBER')
    ) {
      throw new Error('meeting-lifecycle-invalid-request');
    }
    if (
      actor.departmentRole !== undefined &&
      actor.departmentRole !== null &&
      actor.departmentRole !== 'ADMIN' &&
      actor.departmentRole !== 'MEMBER'
    ) {
      throw new Error('meeting-lifecycle-invalid-request');
    }
    if (
      actor.meetingRole !== undefined &&
      actor.meetingRole !== null &&
      actor.meetingRole !== 'MEETING_ADMIN' &&
      actor.meetingRole !== 'REVIEWER' &&
      actor.meetingRole !== 'APPROVER' &&
      actor.meetingRole !== 'VIEWER'
    ) {
      throw new Error('meeting-lifecycle-invalid-request');
    }
  }

  private assertInstant(instant: string): void {
    if (
      typeof instant !== 'string' ||
      instant.trim() === '' ||
      !ISO_8601_INSTANT.test(instant) ||
      Number.isNaN(Date.parse(instant))
    ) {
      throw new Error('meeting-lifecycle-invalid-request');
    }
  }

  private assertMeetUrl(url: string): void {
    if (
      typeof url !== 'string' ||
      !url.startsWith(MEET_HOST_PREFIX) ||
      url.slice(MEET_HOST_PREFIX.length).trim() === ''
    ) {
      throw new Error('meeting-lifecycle-invalid-request');
    }
  }

  private assertRecordIntegrity(
    meeting: MeetingLifecycleRecord,
    expectedMeetingId: string,
  ): void {
    if (
      meeting.meetingId !== expectedMeetingId ||
      typeof meeting.scheduleVersion !== 'number' ||
      !Number.isInteger(meeting.scheduleVersion) ||
      meeting.scheduleVersion < 0
    ) {
      throw new Error('meeting-lifecycle-row-mapping-corrupt');
    }
  }
}
