import { SetupTokenService } from './setup-token.service';
import { ConflictException, Injectable } from '@nestjs/common';

import { PrismaService, SystemRole } from '@meetwise/infrastructure/database';

import { PasswordHasherService } from '../auth/services/password-hasher.service';
import { CompleteSetupDto } from './dto/complete-setup.dto';

@Injectable()
export class SetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly setupTokenService: SetupTokenService,
    private readonly passwordHasherService: PasswordHasherService,
  ) {}

  async completeSetup(dto: CompleteSetupDto, token: unknown) {
    await this.setupTokenService.check(token);
    const passwordHash = await this.passwordHasherService.hash(
      dto.ownerPassword,
    );

    const companyLogoUrl = dto.companyLogoUrl ?? null;

    return this.prisma.$transaction(async (transaction) => {
      const systemSettings = await this.setupTokenService.claim(
        transaction,
        token,
      );

      const existingUsersCount = await transaction.user.count();

      if (existingUsersCount > 0) {
        throw new ConflictException(
          'Setup cannot continue because users already exist',
        );
      }

      const setupClaim = await transaction.systemSetting.updateMany({
        where: {
          id: systemSettings.id,
          setupCompleted: false,
        },
        data: {
          companyName: dto.companyName,
          companyLogoUrl,
          timezone: dto.timezone,
          defaultLanguage: dto.defaultLanguage,
          defaultBotName: dto.defaultBotName,
          setupCompleted: true,
          setupCompletedAt: new Date(),
        },
      });

      if (setupClaim.count !== 1) {
        throw new ConflictException('Initial setup has already been completed');
      }

      const owner = await transaction.user.create({
        data: {
          email: dto.ownerEmail,
          name: dto.ownerName,
          passwordHash,
          role: SystemRole.OWNER,
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
      });

      return {
        setupCompleted: true,
        installationId: systemSettings.installationId,
        company: {
          companyName: dto.companyName,
          companyLogoUrl,
          timezone: dto.timezone,
          defaultLanguage: dto.defaultLanguage,
          defaultBotName: dto.defaultBotName,
        },
        owner,
      };
    });
  }
}
