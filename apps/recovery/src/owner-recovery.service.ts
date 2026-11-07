import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  Prisma,
  PrismaService,
  SystemRole,
} from '@meetwise/infrastructure/database';
import { PasswordHasherService } from '../../api/src/modules/auth/services/password-hasher.service';
import {
  issueOwnerRecoveryCredential,
  matchesOwnerRecoveryDigest,
  ownerRecoveryDigest,
  ownerRecoveryIdentity,
  OWNER_RECOVERY_TTL_MS,
} from './owner-recovery-credential';

interface LockedOwner {
  id: string;
  role: SystemRole;
  isActive: boolean;
  tokenVersion: number;
  passwordHash: string;
}

@Injectable()
export class OwnerRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordHasherService,
  ) {}

  async issue(email: string): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedOwner[]>`
        SELECT id, role, is_active AS "isActive", token_version AS "tokenVersion", password_hash AS "passwordHash"
        FROM users WHERE email = ${email} FOR UPDATE`;
      const owner = this.requireOwner(rows[0]);
      const credential = issueOwnerRecoveryCredential(owner.id);
      const nextVersion = owner.tokenVersion + 1;
      await tx.user.update({
        where: { id: owner.id },
        data: { tokenVersion: nextVersion, refreshTokenHash: null },
      });
      await tx.ownerRecoveryToken.upsert({
        where: { userId: owner.id },
        create: {
          userId: owner.id,
          digest: ownerRecoveryDigest(credential),
          tokenVersion: nextVersion,
          expiresAt: new Date(Date.now() + OWNER_RECOVERY_TTL_MS),
        },
        update: {
          digest: ownerRecoveryDigest(credential),
          tokenVersion: nextVersion,
          expiresAt: new Date(Date.now() + OWNER_RECOVERY_TTL_MS),
          consumedAt: null,
          issuedAt: new Date(),
        },
      });
      await this.audit(tx, owner.id, nextVersion, 'ISSUED');
      return credential;
    });
  }

  async consume(credential: string, newPassword: string): Promise<void> {
    const userId = ownerRecoveryIdentity(credential);
    if (!userId)
      throw new ForbiddenException('Invalid OWNER recovery credential');
    if (
      typeof newPassword !== 'string' ||
      newPassword.length < 12 ||
      newPassword.length > 128
    )
      throw new BadRequestException(
        'New password must contain 12 to 128 characters',
      );
    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<LockedOwner[]>`
        SELECT id, role, is_active AS "isActive", token_version AS "tokenVersion", password_hash AS "passwordHash"
        FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
        const owner = this.requireOwner(rows[0]);
        const token = await tx.ownerRecoveryToken.findUnique({
          where: { userId },
        });
        if (
          !token ||
          token.consumedAt ||
          token.tokenVersion !== owner.tokenVersion ||
          token.expiresAt.getTime() <= Date.now() ||
          !matchesOwnerRecoveryDigest(credential, token.digest)
        )
          throw new ForbiddenException('Invalid OWNER recovery credential');
        if (await this.passwords.verify(newPassword, owner.passwordHash))
          throw new BadRequestException('New password must be different');
        const claim = await tx.ownerRecoveryToken.updateMany({
          where: {
            userId,
            digest: token.digest,
            tokenVersion: owner.tokenVersion,
            consumedAt: null,
            expiresAt: { gt: new Date() },
          },
          data: { consumedAt: new Date() },
        });
        if (claim.count !== 1)
          throw new ForbiddenException('Invalid OWNER recovery credential');
        await tx.user.update({
          where: { id: userId },
          data: {
            passwordHash,
            mustChangePassword: false,
            tokenVersion: { increment: 1 },
            refreshTokenHash: null,
          },
        });
        await this.audit(tx, userId, owner.tokenVersion + 1, 'CONSUMED');
      },
      { timeout: 10000 },
    );
  }

  private requireOwner(user: LockedOwner | undefined): LockedOwner {
    if (!user?.isActive || user.role !== SystemRole.OWNER)
      throw new ForbiddenException('OWNER recovery unavailable');
    return user;
  }

  private audit(
    tx: Prisma.TransactionClient,
    userId: string,
    tokenVersion: number,
    action: 'ISSUED' | 'CONSUMED',
  ) {
    return tx.ownerRecoveryEvent.create({
      data: { userId, tokenVersion, action },
    });
  }
}
