import { Transform } from 'class-transformer';
import {
  Equals,
  IsEmail,
  IsEnum,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { SystemRole } from '@meetwise/infrastructure/database';
export class ProvisionAccountDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
  @IsEnum(SystemRole) systemRole!: SystemRole;
  @Equals('ONE_TIME_LOCAL_ACTIVATION')
  onboardingMode!: 'ONE_TIME_LOCAL_ACTIVATION';
}
