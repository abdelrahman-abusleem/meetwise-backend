import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PrismaService } from '@meetwise/infrastructure/database';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

interface BootstrapState {
  setupCompleted: boolean;
  bootstrapTokenHash: string | null;
  bootstrapExpiresAt: Date | null;
  bootstrapConsumedAt: Date | null;
}

@Injectable()
export class SetupTokenService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO system_settings (id, singleton_key, installation_id, updated_at)
        VALUES (${randomUUID()}::uuid, 'system', ${randomUUID()}::uuid, CURRENT_TIMESTAMP)
        ON CONFLICT (singleton_key) DO NOTHING`;
      const state = await this.lock(tx);
      if (state.setupCompleted) throw new NotFoundException();
      if (await tx.user.count())
        throw new ConflictException(
          'Existing users require explicit installation recovery',
        );
      const token = randomBytes(32).toString('base64url');
      await tx.systemSetting.update({
        where: { singletonKey: 'system' },
        data: {
          bootstrapTokenHash: this.digest(token),
          bootstrapExpiresAt: new Date(Date.now() + 900000),
          bootstrapConsumedAt: null,
        },
      });
      return token;
    });
  }

  async check(token: unknown): Promise<void> {
    const state = await this.prisma.systemSetting.findUnique({
      where: { singletonKey: 'system' },
    });
    this.requireValid(state, token);
  }

  async claim(tx: Prisma.TransactionClient, token: unknown) {
    const state = await this.lock(tx);
    this.requireValid(state, token);
    await tx.systemSetting.update({
      where: { id: state.id },
      data: {
        bootstrapTokenHash: null,
        bootstrapExpiresAt: null,
        bootstrapConsumedAt: new Date(),
      },
    });
    return state;
  }

  private async lock(tx: Prisma.TransactionClient) {
    await tx.$queryRaw`SELECT id FROM system_settings WHERE singleton_key = 'system' FOR UPDATE`;
    const state = await tx.systemSetting.findUnique({
      where: { singletonKey: 'system' },
    });
    if (!state) throw new ForbiddenException('Invalid setup token');
    return state;
  }

  private requireValid(state: BootstrapState | null, token: unknown): void {
    if (state?.setupCompleted) throw new NotFoundException();
    if (
      !state ||
      typeof token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      !state.bootstrapTokenHash ||
      !/^[a-f0-9]{64}$/.test(state.bootstrapTokenHash) ||
      !state.bootstrapExpiresAt ||
      state.bootstrapExpiresAt.getTime() <= Date.now() ||
      state.bootstrapConsumedAt ||
      !timingSafeEqual(
        Buffer.from(state.bootstrapTokenHash, 'hex'),
        Buffer.from(this.digest(token), 'hex'),
      )
    )
      throw new ForbiddenException('Invalid setup token');
  }

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
