import {
  IsRFC3339,
  IsDateString,
  IsIn,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class CreateMeetingDto {
  @IsIn(['GENERAL', 'TECH', 'SALES'])
  kind!: 'GENERAL' | 'TECH' | 'SALES';

  @IsString()
  @Length(1, 240)
  title!: string;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsUUID()
  departmentId?: string;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsIn(['COMPANY', 'DEPARTMENT', 'PRIVATE'])
  visibility?: 'COMPANY' | 'DEPARTMENT' | 'PRIVATE';

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsUUID()
  meetingAdminId?: string;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsRFC3339()
  @IsDateString({ strict: true })
  scheduledAt?: string;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(80)
  timeZone?: string;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(1000)
  joinUrl?: string;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsUUID()
  seriesId?: string;
}
