import {
  ArrayMaxSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import { LicenseEdition } from '@meetwise/infrastructure/database';

export class LicensePayloadDto {
  @IsInt()
  @Equals(1)
  version!: number;

  @Equals('meetwise')
  product!: string;

  @IsUUID()
  licenseId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  customerName!: string;

  @IsUUID()
  installationId!: string;

  @IsEnum(LicenseEdition)
  edition!: LicenseEdition;

  @IsDateString()
  issuedAt!: string;

  @IsOptional()
  @IsDateString()
  updatesExpiresAt!: string | null;

  @IsOptional()
  @IsDateString()
  supportExpiresAt!: string | null;

  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  enabledFeatures!: string[];
}
