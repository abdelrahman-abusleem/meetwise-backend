import { Transform, Type, plainToInstance } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDefined,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  ValidateNested,
  registerDecorator,
  validateSync,
} from 'class-validator';
import { ServiceUnavailableException } from '@nestjs/common';
const present = (_object: unknown, value: unknown) => value !== undefined;
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
function IsTimezone(): PropertyDecorator {
  return (object, key) =>
    registerDecorator({
      name: 'isTimezone',
      target: object.constructor,
      propertyName: String(key),
      validator: {
        validate(value: unknown) {
          if (
            typeof value !== 'string' ||
            value.length > 100 ||
            !/^[A-Za-z][A-Za-z0-9._+/-]*$/.test(value)
          )
            return false;
          try {
            new Intl.DateTimeFormat('en', { timeZone: value });
            return true;
          } catch {
            return false;
          }
        },
      },
    });
}
export class WizardDepartmentPlanDto {
  @IsIn(['TECH', 'SALES']) kind!: 'TECH' | 'SALES';
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  operatorUserIds!: string[];
}
export class WizardConfigDto {
  @ValidateIf(present)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  companyName?: string;
  @ValidateIf(present) @IsTimezone() timezone?: string;
  @ValidateIf(present) @IsIn(['ar', 'en']) defaultLanguage?: 'ar' | 'en';
  @ValidateIf(present)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  defaultBotName?: string;
  @ValidateIf(present) @IsIn(['TECH', 'SALES', 'BOTH']) departmentChoice?:
    'TECH' | 'SALES' | 'BOTH';
  @ValidateIf(present)
  @IsArray()
  @ArrayMaxSize(2)
  @ArrayUnique((p: WizardDepartmentPlanDto | null) => p?.kind)
  @ValidateNested({ each: true })
  @Type(() => WizardDepartmentPlanDto)
  departmentPlans?: WizardDepartmentPlanDto[];
}
export class CreateWizardDraftDto {
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => WizardConfigDto)
  config!: WizardConfigDto;
}
export class UpdateWizardDraftDto extends CreateWizardDraftDto {
  @IsUUID('4') draftId!: string;
}

export function configSnapshot(config: WizardConfigDto) {
  return {
    ...(config.companyName !== undefined
      ? { companyName: config.companyName }
      : {}),
    ...(config.timezone !== undefined ? { timezone: config.timezone } : {}),
    ...(config.defaultLanguage !== undefined
      ? { defaultLanguage: config.defaultLanguage }
      : {}),
    ...(config.defaultBotName !== undefined
      ? { defaultBotName: config.defaultBotName }
      : {}),
    ...(config.departmentChoice !== undefined
      ? { departmentChoice: config.departmentChoice }
      : {}),
    ...(config.departmentPlans !== undefined
      ? {
          departmentPlans: config.departmentPlans.map((p) => ({
            kind: p.kind,
            operatorUserIds: [...p.operatorUserIds],
          })),
        }
      : {}),
  };
}
export function readConfig(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ServiceUnavailableException('Draft configuration unavailable');
  const dto = plainToInstance(WizardConfigDto, value);
  if (
    validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      validationError: { target: false, value: false },
    }).length
  )
    throw new ServiceUnavailableException('Draft configuration unavailable');
  return configSnapshot(dto);
}
