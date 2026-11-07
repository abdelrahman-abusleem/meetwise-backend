import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ActivateLicenseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4_000)
  licenseKey!: string;
}
