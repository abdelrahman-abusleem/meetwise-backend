import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  PrismaService,
  SystemRole,
} from '@meetwise/infrastructure/database';
import { createHash, randomBytes } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { AuthenticatedUser } from './auth.types';
import { ActorAuthorityService } from './services/actor-authority.service';
import { PasswordHasherService } from './services/password-hasher.service';
import {
  administrativeResetDigest,
  administrativeResetIdentity,
  matchesAdministrativeResetDigest,
} from './administrative-reset-credential';
import {
  ADMINISTRATIVE_RESET_TTL_MS,
  mayAdministrativelyReset,
} from './administrative-reset.policy';

interface ResetUser {
  id: string;
  role: SystemRole;
  isActive: boolean;
  mustChangePassword: boolean;
  tokenVersion: number;
  passwordHash: string;
}

@Injectable()
export class AdministrativeResetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authority: ActorAuthorityService,
    private readonly passwords: PasswordHasherService,
  ) {}

  async issue(actor: AuthenticatedUser, userId: string, requestKey: unknown) {
    if (!isUUID(userId)) throw new BadRequestException('Invalid target');
    const requestHash = this.requestHash(requestKey);
    return this.prisma.$transaction(
      async (tx) => {
        await this.authority.assertActiveSystemActor(
          tx,
          actor,
          [SystemRole.OWNER, SystemRole.MANAGER],
          userId,
        );
        const issuer = await tx.user.findUniqueOrThrow({
          where: { id: actor.id },
        });
        const target = await tx.user.findUnique({ where: { id: userId } });
        if (!target) throw new NotFoundException();
        if (
          !target.isActive ||
          !mayAdministrativelyReset(issuer.role, target.role)
        )
          throw new ForbiddenException('Reset target is not permitted');
        const previous = await tx.administrativeResetEvent.findFirst({
          where: { issuerId: actor.id, userId, requestHash },
          select: { id: true },
        });
        if (previous)
          throw new ConflictException(
            'Reset request already issued; use a new request key to replace it',
          );
        const credential = `${userId}.${randomBytes(32).toString('base64url')}`;
        const issuedAt = new Date();
        const expiresAt = new Date(
          issuedAt.getTime() + ADMINISTRATIVE_RESET_TTL_MS,
        );
        const tokenVersion = target.tokenVersion + 1;
        await tx.user.update({
          where: { id: userId },
          data: {
            mustChangePassword: true,
            tokenVersion,
            refreshTokenHash: null,
          },
        });
        const data = {
          issuerId: actor.id,
          issuerTokenVersion: issuer.tokenVersion,
          targetRole: target.role,
          tokenVersion,
          digest: administrativeResetDigest(credential),
          issuedAt,
          expiresAt,
          consumedAt: null,
        };
        await tx.administrativeResetToken.upsert({
          where: { userId },
          create: { userId, ...data },
          update: data,
        });
        await tx.administrativeResetEvent.create({
          data: {
            issuerId: actor.id,
            userId,
            tokenVersion,
            action: 'ISSUED',
            requestHash,
          },
        });
        await this.authority.assertActiveSystemActor(
          tx,
          actor,
          [SystemRole.OWNER, SystemRole.MANAGER],
          userId,
        );
        return { credential, expiresAt };
      },
      { timeout: 10000 },
    );
  }

  async consume(credential: string, newPassword: string): Promise<void> {
    const userId = administrativeResetIdentity(credential);
    if (!userId) throw new ForbiddenException('Invalid temporary credential');
    if (
      typeof newPassword !== 'string' ||
      newPassword.length < 12 ||
      newPassword.length > 128
    )
      throw new BadRequestException(
        'New password must contain 12 to 128 characters',
      );

    const initial = await this.prisma.administrativeResetToken.findUnique({
      where: { userId },
    });
    if (
      !initial ||
      initial.consumedAt ||
      initial.expiresAt.getTime() <= Date.now() ||
      !matchesAdministrativeResetDigest(credential, initial.digest)
    )
      throw new ForbiddenException('Invalid temporary credential');
    await this.prisma.$transaction(
      async (tx) => {
        const users = await this.lockUsers(tx, initial.issuerId, userId);
        const issuer = users.find((user) => user.id === initial.issuerId);
        const target = users.find((user) => user.id === userId);
        const state = await tx.administrativeResetToken.findUnique({
          where: { userId },
        });
        if (
          !state ||
          state.issuerId !== initial.issuerId ||
          state.consumedAt ||
          state.expiresAt.getTime() <= Date.now() ||
          !matchesAdministrativeResetDigest(credential, state.digest) ||
          !issuer?.isActive ||
          issuer.mustChangePassword ||
          issuer.tokenVersion !== state.issuerTokenVersion ||
          !target?.isActive ||
          !target.mustChangePassword ||
          target.tokenVersion !== state.tokenVersion ||
          target.role !== state.targetRole ||
          !mayAdministrativelyReset(issuer.role, target.role)
        )
          throw new ForbiddenException('Invalid temporary credential');
        if (await this.passwords.verify(newPassword, target.passwordHash))
          throw new BadRequestException('New password must be different');
        const passwordHash = await this.passwords.hash(newPassword);
        if (state.expiresAt.getTime() <= Date.now())
          throw new ForbiddenException('Invalid temporary credential');
        const claim = await tx.administrativeResetToken.updateMany({
          where: {
            userId,
            issuerId: issuer.id,
            digest: state.digest,
            consumedAt: null,
            tokenVersion: target.tokenVersion,
            expiresAt: { gt: new Date() },
          },
          data: { consumedAt: new Date() },
        });
        if (claim.count !== 1)
          throw new ForbiddenException('Invalid temporary credential');
        await tx.user.update({
          where: { id: userId },
          data: {
            passwordHash,
            mustChangePassword: false,
            refreshTokenHash: null,
            tokenVersion: { increment: 1 },
          },
        });
        await tx.administrativeResetEvent.create({
          data: {
            issuerId: issuer.id,
            userId,
            tokenVersion: target.tokenVersion + 1,
            action: 'CONSUMED',
          },
        });
      },
      { timeout: 10000 },
    );
  }

  private lockUsers(
    tx: Prisma.TransactionClient,
    issuerId: string,
    userId: string,
  ) {
    return tx.$queryRaw<ResetUser[]>`
      SELECT id, role, is_active AS "isActive", must_change_password AS "mustChangePassword",
             token_version AS "tokenVersion", password_hash AS "passwordHash"
      FROM users WHERE id IN (${issuerId}::uuid, ${userId}::uuid) ORDER BY id FOR UPDATE`;
  }

  private requestHash(key: unknown): string {
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key))
      throw new BadRequestException('A valid Idempotency-Key is required');
    return createHash('sha256').update(key).digest('hex');
  }
}
