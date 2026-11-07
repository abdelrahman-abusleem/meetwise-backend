import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { PrismaService } from '@meetwise/infrastructure/database';
import { RefreshTokenHasherService } from './refresh-token-hasher.service';

export interface SessionIdentity {
  familyId: string;
  userId: string;
  tokenVersion: number;
}
interface NewFamily extends SessionIdentity {
  refreshToken: string;
  expiresAt: Date;
}
interface Rotation extends NewFamily {
  nextRefreshToken: string;
}
interface LockedFamily {
  id: string;
  refreshHash: string;
  tokenVersion: number;
  expiresAt: Date;
  revokedAt: Date | null;
}

@Injectable()
export class SessionFamilyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: RefreshTokenHasherService,
  ) {}

  async create(input: NewFamily): Promise<void> {
    this.requireIdentity(input);
    this.requireFutureExpiration(input.expiresAt);
    const refreshHash = this.hasher.hashForFamily(input.refreshToken);
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: input.userId },
        select: {
          isActive: true,
          mustChangePassword: true,
          tokenVersion: true,
        },
      });
      if (
        !user?.isActive ||
        user.mustChangePassword ||
        user.tokenVersion !== input.tokenVersion
      )
        throw new UnauthorizedException('Invalid session');
      await tx.authSession.create({
        data: {
          id: input.familyId,
          userId: input.userId,
          tokenVersion: input.tokenVersion,
          refreshHash,
          expiresAt: input.expiresAt,
        },
      });
    });
  }

  async rotate(input: Rotation): Promise<void> {
    this.requireIdentity(input);
    this.requireFutureExpiration(input.expiresAt);
    if (
      this.hasher.compareForFamily(
        input.nextRefreshToken,
        this.hasher.hashForFamily(input.refreshToken),
      )
    ) {
      throw new BadRequestException('Rotation requires a new token');
    }
    const nextHash = this.hasher.hashForFamily(input.nextRefreshToken);
    const rotated = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedFamily[]>`
        SELECT id, refresh_hash AS "refreshHash", token_version AS "tokenVersion",
               expires_at AS "expiresAt", revoked_at AS "revokedAt"
        FROM auth_sessions
        WHERE id = ${input.familyId}::uuid AND user_id = ${input.userId}::uuid
        FOR UPDATE`;
      const family = rows[0];
      if (
        !family ||
        family.revokedAt ||
        family.expiresAt.getTime() <= Date.now() ||
        family.tokenVersion !== input.tokenVersion
      )
        return false;
      const user = await tx.user.findUnique({
        where: { id: input.userId },
        select: {
          isActive: true,
          mustChangePassword: true,
          tokenVersion: true,
        },
      });
      if (
        !user?.isActive ||
        user.mustChangePassword ||
        user.tokenVersion !== input.tokenVersion
      )
        return false;
      if (
        !this.hasher.compareForFamily(input.refreshToken, family.refreshHash)
      ) {
        await tx.authSession.update({
          where: { id: family.id },
          data: { revokedAt: new Date() },
        });
        return false;
      }
      const result = await tx.authSession.updateMany({
        where: {
          id: family.id,
          userId: input.userId,
          refreshHash: family.refreshHash,
          revokedAt: null,
          expiresAt: { gt: new Date() },
          user: {
            isActive: true,
            mustChangePassword: false,
            tokenVersion: input.tokenVersion,
          },
        },
        data: {
          refreshHash: nextHash,
          rotationCounter: { increment: 1 },
          expiresAt: input.expiresAt,
        },
      });
      return result.count === 1;
    });

    if (!rotated) throw new UnauthorizedException('Invalid session');
  }

  async isValid(identity: SessionIdentity): Promise<boolean> {
    if (!this.hasIdentity(identity)) return false;
    const family = await this.prisma.authSession.findFirst({
      where: {
        id: identity.familyId,
        userId: identity.userId,
        tokenVersion: identity.tokenVersion,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        user: {
          isActive: true,
          mustChangePassword: false,
          tokenVersion: identity.tokenVersion,
        },
      },
      select: { id: true },
    });
    return family !== null;
  }

  async revokeFamily(
    identity: Pick<SessionIdentity, 'familyId' | 'userId'>,
  ): Promise<void> {
    if (!isUUID(identity.familyId) || !isUUID(identity.userId))
      throw new UnauthorizedException('Invalid session');
    await this.prisma.authSession.updateMany({
      where: {
        id: identity.familyId,
        userId: identity.userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }
  async revokeAll(userId: string): Promise<void> {
    if (!isUUID(userId)) throw new UnauthorizedException('Invalid session');
    await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  private hasIdentity(identity: SessionIdentity): boolean {
    return (
      isUUID(identity.familyId) &&
      isUUID(identity.userId) &&
      Number.isInteger(identity.tokenVersion) &&
      identity.tokenVersion >= 0
    );
  }
  private requireIdentity(identity: SessionIdentity): void {
    if (!this.hasIdentity(identity))
      throw new UnauthorizedException('Invalid session');
  }
  private requireFutureExpiration(value: Date): void {
    if (!(value instanceof Date) || !(value.getTime() > Date.now()))
      throw new BadRequestException('Invalid session expiration');
  }
}
