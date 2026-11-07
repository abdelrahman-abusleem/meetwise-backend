import { Injectable } from '@nestjs/common';

import { PrismaService } from '@meetwise/infrastructure/database';

import { SYSTEM_SINGLETON_KEY } from '../../common/constants/system.constants';

@Injectable()
export class SystemSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  getOrCreate() {
    return this.prisma.systemSetting.upsert({
      select: {
        id: true,
        singletonKey: true,
        companyName: true,
        companyLogoUrl: true,
        timezone: true,
        defaultLanguage: true,
        defaultBotName: true,
        recordingConsentRequired: true,
        retentionDays: true,
        autoDeleteTranscripts: true,
        allowAudioStorage: true,
        setupCompleted: true,
        setupCompletedAt: true,
        productVersion: true,
        installationId: true,
        createdAt: true,
        updatedAt: true,
      },
      where: {
        singletonKey: SYSTEM_SINGLETON_KEY,
      },
      update: {},
      create: {
        singletonKey: SYSTEM_SINGLETON_KEY,
      },
    });
  }
}
