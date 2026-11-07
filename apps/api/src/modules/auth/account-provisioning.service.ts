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
import type { AuthenticatedUser } from './auth.types';
import { ActorAuthorityService } from './services/actor-authority.service';
import { PasswordHasherService } from './services/password-hasher.service';
import { ProvisionAccountDto } from './dto/provision-account.dto';
import { ACTIVATION_TTL_MS, mayProvisionRole } from './provisioning.policy';
import {
  activationCredential,
  activationDigest,
  activationIdentity,
  matchesActivationDigest,
} from './activation-credential';
interface ActivationUser {
  id: string;
  role: SystemRole;
  isActive: boolean;
  mustChangePassword: boolean;
  tokenVersion: number;
}
@Injectable()
export class AccountProvisioningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authority: ActorAuthorityService,
    private readonly passwords: PasswordHasherService,
  ) {}

  async provision(
    actor: AuthenticatedUser,
    dto: ProvisionAccountDto,
    key: unknown,
  ) {
    const requestHash = this.requestHash(key);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await this.assertIssuer(tx, actor);
          const issuer = await tx.user.findUniqueOrThrow({
            where: { id: actor.id },
          });
          this.requireRole(issuer.role, dto.systemRole);
          await this.requireFreshRequest(tx, issuer.id, requestHash);
          if (
            await tx.user.findFirst({
              where: { email: { equals: dto.email, mode: 'insensitive' } },
              select: { id: true },
            })
          )
            throw new ConflictException('Account already exists');

          const passwordHash = await this.passwords.hash(
            randomBytes(32).toString('base64url'),
          );
          const user = await tx.user.create({
            data: {
              email: dto.email,
              name: dto.name,
              role: dto.systemRole,
              isActive: false,
              mustChangePassword: true,
              passwordHash,
            },
          });
          const activation = await this.issue(tx, issuer, user, requestHash);
          await this.assertIssuer(tx, actor);
          return {
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
              systemRole: user.role,
              active: false,
            },
            ...activation,
            onboardingMode: 'ONE_TIME_LOCAL_ACTIVATION' as const,
          };
        },
        { timeout: 10000 },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException('Account or request already exists');
      throw error;
    }
  }

  async replace(actor: AuthenticatedUser, userId: string, key: unknown) {
    const requestHash = this.requestHash(key);
    return this.prisma.$transaction(
      async (tx) => {
        await this.assertIssuer(tx, actor, userId);
        const issuer = await tx.user.findUniqueOrThrow({
            where: { id: actor.id },
          }),
          target = await this.pendingTarget(tx, userId);
        this.requireRole(issuer.role, target.role);
        await this.requireFreshRequest(tx, issuer.id, requestHash);
        const user = await tx.user.update({
          where: { id: userId },
          data: { tokenVersion: { increment: 1 } },
        });
        const activation = await this.issue(tx, issuer, user, requestHash);
        await this.assertIssuer(tx, actor, userId);
        return activation;
      },
      { timeout: 10000 },
    );
  }

  async revoke(actor: AuthenticatedUser, userId: string): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        await this.assertIssuer(tx, actor, userId);
        const issuer = await tx.user.findUniqueOrThrow({
            where: { id: actor.id },
          }),
          target = await this.pendingTarget(tx, userId);
        this.requireRole(issuer.role, target.role);
        const token = await tx.activationToken.findUniqueOrThrow({
          where: { userId },
        });
        if (token.revokedAt) {
          await this.assertIssuer(tx, actor, userId);
          return;
        }
        await tx.activationToken.update({
          where: { userId },
          data: { revokedAt: new Date() },
        });
        const user = await tx.user.update({
          where: { id: userId },
          data: { tokenVersion: { increment: 1 } },
        });
        await tx.activationEvent.create({
          data: {
            userId,
            issuerId: issuer.id,
            tokenVersion: user.tokenVersion,
            action: 'REVOKED',
          },
        });
        await this.assertIssuer(tx, actor, userId);
      },
      { timeout: 10000 },
    );
  }

  async activate(credential: string, newPassword: string): Promise<void> {
    const userId = activationIdentity(credential);
    if (!userId) throw new ForbiddenException('Invalid activation credential');
    if (
      typeof newPassword !== 'string' ||
      newPassword.length < 12 ||
      newPassword.length > 128
    )
      throw new BadRequestException(
        'New password must contain12 to128 characters',
      );
    const initial = await this.prisma.activationToken.findUnique({
      where: { userId },
    });
    if (
      !initial ||
      initial.consumedAt ||
      initial.revokedAt ||
      initial.expiresAt.getTime() <= Date.now() ||
      !matchesActivationDigest(credential, initial.digest)
    )
      throw new ForbiddenException('Invalid activation credential');
    await this.prisma.$transaction(
      async (tx) => {
        const users = await tx.$queryRaw<
          ActivationUser[]
        >`SELECT id,role,is_active AS "isActive",must_change_password AS "mustChangePassword",token_version AS "tokenVersion" FROM users WHERE id IN (${initial.issuerId}::uuid,${userId}::uuid) ORDER BY id FOR UPDATE`;
        const issuer = users.find((u) => u.id === initial.issuerId),
          target = users.find((u) => u.id === userId),
          state = await tx.activationToken.findUnique({ where: { userId } });
        if (
          !state ||
          state.issuerId !== initial.issuerId ||
          state.consumedAt ||
          state.revokedAt ||
          state.expiresAt.getTime() <= Date.now() ||
          !matchesActivationDigest(credential, state.digest) ||
          !issuer?.isActive ||
          issuer.mustChangePassword ||
          issuer.tokenVersion !== state.issuerTokenVersion ||
          !target ||
          target.isActive ||
          !target.mustChangePassword ||
          target.tokenVersion !== state.tokenVersion ||
          target.role !== state.targetRole ||
          !mayProvisionRole(issuer.role, target.role)
        )
          throw new ForbiddenException('Invalid activation credential');
        const passwordHash = await this.passwords.hash(newPassword);
        if (state.expiresAt.getTime() <= Date.now())
          throw new ForbiddenException('Invalid activation credential');
        const claim = await tx.activationToken.updateMany({
          where: {
            userId,
            consumedAt: null,
            revokedAt: null,
            digest: state.digest,
            tokenVersion: target.tokenVersion,
            expiresAt: { gt: new Date() },
          },
          data: { consumedAt: new Date() },
        });
        if (claim.count !== 1)
          throw new ForbiddenException('Invalid activation credential');
        await tx.user.update({
          where: { id: userId },
          data: {
            isActive: true,
            mustChangePassword: false,
            passwordHash,
            refreshTokenHash: null,
            tokenVersion: { increment: 1 },
          },
        });
        await tx.activationEvent.create({
          data: {
            userId,
            issuerId: issuer.id,
            tokenVersion: target.tokenVersion + 1,
            action: 'CONSUMED',
          },
        });
      },
      { timeout: 10000 },
    );
  }

  private async pendingTarget(tx: Prisma.TransactionClient, userId: string) {
    const target = await tx.user.findUnique({ where: { id: userId } }),
      state = await tx.activationToken.findUnique({ where: { userId } });
    if (!target || !state) throw new NotFoundException();
    if (
      target.isActive ||
      !target.mustChangePassword ||
      state.consumedAt ||
      target.role !== state.targetRole
    )
      throw new ForbiddenException('Account is not pending activation');
    return target;
  }
  private async assertIssuer(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    userId?: string,
  ) {
    await this.authority.assertActiveSystemActor(
      tx,
      actor,
      [SystemRole.OWNER, SystemRole.MANAGER],
      userId,
    );
  }
  private async issue(
    tx: Prisma.TransactionClient,
    issuer: ActivationUser,
    target: ActivationUser,
    requestHash: string,
  ) {
    const activationSecret = activationCredential(target.id),
      issuedAt = new Date(),
      activationExpiresAt = new Date(issuedAt.getTime() + ACTIVATION_TTL_MS);
    const data = {
      issuerId: issuer.id,
      issuerTokenVersion: issuer.tokenVersion,
      targetRole: target.role,
      tokenVersion: target.tokenVersion,
      digest: activationDigest(activationSecret),
      issuedAt,
      expiresAt: activationExpiresAt,
      consumedAt: null,
      revokedAt: null,
    };
    await tx.activationToken.upsert({
      where: { userId: target.id },
      create: { userId: target.id, ...data },
      update: data,
    });
    await tx.activationEvent.create({
      data: {
        issuerId: issuer.id,
        userId: target.id,
        tokenVersion: target.tokenVersion,
        action: 'ISSUED',
        requestHash,
      },
    });
    return { activationSecret, activationExpiresAt };
  }
  private requireRole(issuer: SystemRole, target: SystemRole) {
    if (!mayProvisionRole(issuer, target))
      throw new ForbiddenException('Provisioning role is not permitted');
  }
  private requestHash(key: unknown): string {
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key))
      throw new BadRequestException('A valid Idempotency-Key is required');
    return createHash('sha256').update(key).digest('hex');
  }
  private async requireFreshRequest(
    tx: Prisma.TransactionClient,
    issuerId: string,
    requestHash: string,
  ) {
    if (
      await tx.activationEvent.findFirst({
        where: { issuerId, requestHash },
        select: { id: true },
      })
    )
      throw new ConflictException(
        'Activation request already issued; use a new key',
      );
  }
}
