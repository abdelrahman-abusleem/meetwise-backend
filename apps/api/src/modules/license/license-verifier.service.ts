import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { createHash, createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { LicensePayloadDto } from './dto/license-payload.dto';

const LICENSE_PREFIX = 'MW1';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface VerifiedLicense {
  payload: LicensePayloadDto;
  signature: string;
  licenseKeyHash: string;
}

@Injectable()
export class LicenseVerifierService implements OnModuleInit {
  private publicKey!: KeyObject;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const configuredPath = this.configService.getOrThrow<string>(
      'LICENSE_PUBLIC_KEY_PATH',
    );

    const publicKeyPath = isAbsolute(configuredPath)
      ? configuredPath
      : resolve(process.cwd(), configuredPath);

    const publicKeyPem = readFileSync(publicKeyPath, 'utf8');

    this.publicKey = createPublicKey(publicKeyPem);
  }

  verifyLicenseKey(rawLicenseKey: string): VerifiedLicense {
    const licenseKey = rawLicenseKey.trim();
    const parts = licenseKey.split('.');

    if (parts.length !== 3) {
      throw new BadRequestException('Invalid license key format');
    }

    const [prefix, payloadPart, signaturePart] = parts;

    if (
      prefix !== LICENSE_PREFIX ||
      !payloadPart ||
      !signaturePart ||
      !BASE64URL_PATTERN.test(payloadPart) ||
      !BASE64URL_PATTERN.test(signaturePart)
    ) {
      throw new BadRequestException('Invalid license key format');
    }

    const signedContent = Buffer.from(`${prefix}.${payloadPart}`, 'utf8');

    const signatureBuffer = Buffer.from(signaturePart, 'base64url');

    const validSignature = verify(
      null,
      signedContent,
      this.publicKey,
      signatureBuffer,
    );

    if (!validSignature) {
      throw new BadRequestException('Invalid license signature');
    }

    let rawPayload: unknown;

    try {
      const payloadJson = Buffer.from(payloadPart, 'base64url').toString(
        'utf8',
      );

      rawPayload = JSON.parse(payloadJson);
    } catch {
      throw new BadRequestException('Invalid license payload');
    }

    if (
      rawPayload === null ||
      typeof rawPayload !== 'object' ||
      Array.isArray(rawPayload)
    ) {
      throw new BadRequestException('Invalid license payload');
    }

    const payload = plainToInstance(LicensePayloadDto, rawPayload);

    const validationErrors = validateSync(payload, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    if (validationErrors.length > 0) {
      throw new BadRequestException('Invalid license payload');
    }

    const licenseKeyHash = createHash('sha256')
      .update(licenseKey, 'utf8')
      .digest('hex');

    return {
      payload,
      signature: signaturePart,
      licenseKeyHash,
    };
  }
}
