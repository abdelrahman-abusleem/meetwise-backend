import { IsString, MaxLength, MinLength } from 'class-validator';

export class TemporaryPasswordDto {
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  newPassword!: string;
}
