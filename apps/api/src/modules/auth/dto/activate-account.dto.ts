import { IsString, MinLength, MaxLength } from 'class-validator';
export class ActivateAccountDto {
  @IsString() @MinLength(12) @MaxLength(128) newPassword!: string;
}
