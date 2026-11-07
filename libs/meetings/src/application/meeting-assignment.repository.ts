export interface MeetingAssignmentRecord {
  readonly id: string;
  readonly meetingId: string;
  readonly userId: string;

  readonly assignedById: string;
}

export interface MeetingAssignmentRepository {
  createAssignments(
    role: 'APPROVER' | 'REVIEWER',
    records: readonly MeetingAssignmentRecord[],
  ): Promise<{ created: readonly MeetingAssignmentRecord[] }>;
  revokeMeetingApproverAssignment(
    assignmentId: string,
    meetingId: string,
    actorId: string,
  ): Promise<{ record: MeetingAssignmentRecord }>;
  revokeMeetingReviewerAssignment(
    assignmentId: string,
    meetingId: string,
    actorId: string,
  ): Promise<{ record: MeetingAssignmentRecord }>;
}
