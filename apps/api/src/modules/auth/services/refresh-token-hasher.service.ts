import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import { EnvironmentVariables } from '@meetwise/infrastructure/config';

@Injectable()
export class RefreshTokenHasherService {
  private readonly secret: string;
  private readonly familyKey: Buffer;

  constructor(configService: ConfigService<EnvironmentVariables, true>) {
    this.secret = configService.getOrThrow('JWT_REFRESH_SECRET');
    this.familyKey = Buffer.from(
      hkdfSync('sha256', this.secret, 'MeetWise', 'refresh-family-hash-v1', 32),
    );
  }

  hash(refreshToken: string): string {
    return createHmac('sha256', this.secret)
      .update(refreshToken, 'utf8')
      .digest('hex');
  }

  hashForFamily(refreshToken: string): string {
    return createHmac('sha256', this.familyKey)
      .update(refreshToken, 'utf8')
      .digest('hex');
  }

  compareForFamily(refreshToken: string, storedHash: string): boolean {
    return this.compareDigest(this.hashForFamily(refreshToken), storedHash);
  }

  compare(refreshToken: string, storedHash: string): boolean {
    return this.compareDigest(this.hash(refreshToken), storedHash);
  }

  private compareDigest(candidateHash: string, storedHash: string): boolean {
    if (!/^[a-f0-9]{64}$/i.test(storedHash)) return false;
    return timingSafeEqual(
      Buffer.from(candidateHash, 'hex'),
      Buffer.from(storedHash, 'hex'),
    );
  }
}
