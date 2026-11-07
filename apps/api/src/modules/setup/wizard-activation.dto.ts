import { IsUUID } from 'class-validator';
export class ActivateWizardDto {
  @IsUUID('4') draftId!: string;
}
