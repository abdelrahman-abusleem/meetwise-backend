import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { DepartmentRole } from '@meetwise/infrastructure/database';
export class MembershipGrantDto {
  @IsEnum(DepartmentRole) role!: DepartmentRole;
  @IsBoolean() canCreateMeetings!: boolean;
  @IsBoolean() canManageMeetings!: boolean;
  @IsBoolean() canApproveMeetings!: boolean;
}
export class CreateMembershipDto extends MembershipGrantDto {
  @IsUUID() userId!: string;
}
export class MembershipPageDto {
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}
