export interface CreatedMeetingContract {
  id: string;
  kind: 'GENERAL' | 'TECH' | 'SALES';
  departmentId: string | null;
  visibility: 'COMPANY' | 'DEPARTMENT' | 'PRIVATE';
  title: string;
  createdById: string;
  meetingAdminId: string;
  lifecycle: 'DRAFT';
  version: 0;
  scheduleVersion: 0;
  scheduledAt: string | null;
}
export function assertCreatedMeeting(
  value: unknown,
): asserts value is CreatedMeetingContract;
