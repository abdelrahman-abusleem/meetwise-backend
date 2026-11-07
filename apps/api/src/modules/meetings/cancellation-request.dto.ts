import { IsString, Matches, MaxLength } from 'class-validator';

export class CancellationRequestDto {
  @IsString()
  @Matches(/\S/)
  @MaxLength(1000)
  reason!: string;
}
