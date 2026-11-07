import { BadRequestException } from '@nestjs/common';
import type { WizardConfigDto } from './wizard-config.dto';
export function completeWizardConfig(config: WizardConfigDto) {
  const {
    companyName,
    timezone,
    defaultLanguage,
    defaultBotName,
    departmentChoice,
    departmentPlans,
  } = config;
  if (
    !companyName ||
    !timezone ||
    !defaultLanguage ||
    !defaultBotName ||
    !departmentChoice ||
    !departmentPlans
  )
    throw new BadRequestException('Complete wizard configuration is required');
  const kinds: ('TECH' | 'SALES')[] =
    departmentChoice === 'BOTH' ? ['SALES', 'TECH'] : [departmentChoice];
  if (
    departmentPlans.length !== kinds.length ||
    kinds.some(
      (kind) =>
        !departmentPlans.some(
          (p) => p.kind === kind && p.operatorUserIds.length,
        ),
    )
  )
    throw new BadRequestException(
      'Each selected department requires an explicit eligible operator plan',
    );
  return {
    companyName,
    timezone,
    defaultLanguage,
    defaultBotName,
    departmentChoice,
    departmentPlans,
    kinds,
  };
}
