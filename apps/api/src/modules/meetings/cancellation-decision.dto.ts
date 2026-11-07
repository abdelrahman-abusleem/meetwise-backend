import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
export class CancellationDecisionDto {
  @IsIn(['APPROVE', 'REJECT', 'REASSIGN'])
  decision!: 'APPROVE' | 'REJECT' | 'REASSIGN';
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
  @IsOptional()
  @IsUUID()
  newMeetingAdminId?: string;
}
