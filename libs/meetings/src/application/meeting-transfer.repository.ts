export interface ManagementTransferRecord {
  readonly id: string;
  readonly meetingId: string;
  readonly oldMeetingAdminId: string;
  readonly newMeetingAdminId: string;
  readonly changedById: string;
  readonly reason: string;

  readonly createdAt: string;
}

export interface MeetingTransferRepository {
  commitManagerTransfer(
    record: ManagementTransferRecord,
    expectedMeetingVersion: number,
  ): Promise<{ record: ManagementTransferRecord; meetingVersion: number }>;
}
