import { BadRequestException, Injectable } from '@nestjs/common';
import { instanceToPlain } from 'class-transformer';

import {
  LicenseStatus,
  PrismaService,
} from '@meetwise/infrastructure/database';

import { SYSTEM_SINGLETON_KEY } from '../../common/constants/system.constants';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { LicenseVerifierService } from './license-verifier.service';

@Injectable()
export class LicenseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly licenseVerifierService: LicenseVerifierService,
  ) {}

  private getEntitlement(expiresAt: Date | null, now: Date) {
    return {
      included: expiresAt !== null,
      active: expiresAt !== null && expiresAt.getTime() > now.getTime(),
      expiresAt,
    };
  }

  async getCurrentStatus() {
    const systemSettings = await this.systemSettingsService.getOrCreate();

    const license = await this.prisma.license.findUnique({
      where: {
        singletonKey: SYSTEM_SINGLETON_KEY,
      },
      select: {
        customerName: true,
        status: true,
        edition: true,
        activatedAt: true,
        updatesExpiresAt: true,
        supportExpiresAt: true,
        enabledFeatures: true,
        lastVerifiedAt: true,
      },
    });

    if (!license) {
      return {
        installationId: systemSettings.installationId,
        activated: false,
        license: null,
        entitlements: null,
      };
    }

    const now = new Date();

    return {
      installationId: systemSettings.installationId,
      activated: license.status === LicenseStatus.ACTIVE,
      license,
      entitlements: {
        perpetual: true,
        updates: this.getEntitlement(license.updatesExpiresAt, now),
        support: this.getEntitlement(license.supportExpiresAt, now),
      },
    };
  }

  async activate(rawLicenseKey: string) {
    const systemSettings = await this.systemSettingsService.getOrCreate();

    const { payload, signature, licenseKeyHash } =
      this.licenseVerifierService.verifyLicenseKey(rawLicenseKey);

    if (payload.installationId !== systemSettings.installationId) {
      throw new BadRequestException(
        'License does not belong to this installation',
      );
    }

    const now = new Date();

    const licenseData = {
      licenseKeyHash,
      customerName: payload.customerName,
      installationId: payload.installationId,
      status: LicenseStatus.ACTIVE,
      edition: payload.edition,
      issuedAt: new Date(payload.issuedAt),
      activatedAt: now,
      updatesExpiresAt: payload.updatesExpiresAt
        ? new Date(payload.updatesExpiresAt)
        : null,
      supportExpiresAt: payload.supportExpiresAt
        ? new Date(payload.supportExpiresAt)
        : null,
      enabledFeatures: payload.enabledFeatures,
      licensePayload: instanceToPlain(payload),
      signature,
      lastVerifiedAt: now,
    };

    await this.prisma.license.upsert({
      where: {
        singletonKey: SYSTEM_SINGLETON_KEY,
      },
      update: licenseData,
      create: {
        singletonKey: SYSTEM_SINGLETON_KEY,
        ...licenseData,
      },
    });

    return this.getCurrentStatus();
  }
}
