import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService, SystemRole } from '@meetwise/infrastructure/database';
import {
  ACCOUNT_INACTIVE,
  AUTH_STATE_CHANGED,
  INVALID_ACCESS_TOKEN,
  INVALID_CREDENTIALS,
  INVALID_CURRENT_PASSWORD,
  INVALID_REFRESH_TOKEN,
  NEW_PASSWORD_MUST_BE_DIFFERENT,
} from '../../common/constants/auth.constants';
import {
  authContextUserSelect,
  publicAuthUserSelect,
  refreshAuthUserSelect,
  toPublicAuthUser,
} from './auth.select';
import { LoginDto } from './dto/login.dto';
import { ActorAuthorityService } from './services/actor-authority.service';
import { AuthSessionService } from './services/auth-session.service';
import { AuthTokenService } from './services/auth-token.service';
import { PasswordHasherService } from './services/password-hasher.service';
import { randomUUID } from 'node:crypto';
import { SessionFamilyService } from './services/session-family.service';
import {
  INVALID_PASSWORD_RESET_TOKEN,
  PasswordResetTokenService,
} from '@meetwise/security';
import { QueueProducerService } from '@meetwise/infrastructure/queue';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordHasherService: PasswordHasherService,
    private readonly authTokenService: AuthTokenService,
    private readonly families: SessionFamilyService,
    private readonly authSessionService: AuthSessionService,
    private readonly passwordResetTokenService: PasswordResetTokenService,
    private readonly queueProducerService: QueueProducerService,
    private readonly authority: ActorAuthorityService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: authContextUserSelect,
    });
    if (!user || user.mustChangePassword)
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    if (!user.isActive) throw new ForbiddenException(ACCOUNT_INACTIVE);
    if (
      !(await this.passwordHasherService.verify(
        dto.password,
        user.passwordHash,
      ))
    )
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    const updatedPasswordHash = this.passwordHasherService.needsRehash(
      user.passwordHash,
    )
      ? await this.passwordHasherService.hash(dto.password)
      : undefined;
    const updatedUser = await this.prisma.$transaction(async (tx) => {
      const result = await tx.user.updateMany({
        where: {
          id: user.id,
          isActive: true,
          mustChangePassword: false,
          tokenVersion: user.tokenVersion,
        },
        data: {
          lastLoginAt: new Date(),
          ...(updatedPasswordHash ? { passwordHash: updatedPasswordHash } : {}),
        },
      });
      if (result.count !== 1) throw new ConflictException(AUTH_STATE_CHANGED);
      return tx.user.findUniqueOrThrow({
        where: { id: user.id },
        select: publicAuthUserSelect,
      });
    });
    const familyId = randomUUID();
    const tokens = await this.authTokenService.issueTokenPair(user, familyId);
    await this.families.create({
      familyId,
      userId: user.id,
      tokenVersion: user.tokenVersion,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.refreshTokenExpiresAt,
    });
    return { ...tokens, user: toPublicAuthUser(updatedUser) };
  }

  async getCurrentUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: publicAuthUserSelect,
    });

    if (!user) {
      throw new UnauthorizedException(INVALID_ACCESS_TOKEN);
    }

    return toPublicAuthUser(user);
  }

  async refresh(refreshToken: string) {
    const payload =
      await this.authTokenService.verifyRefreshToken(refreshToken);
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: refreshAuthUserSelect,
    });
    if (
      !user?.isActive ||
      user.mustChangePassword ||
      user.tokenVersion !== payload.tokenVersion
    )
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
    const tokens = await this.authTokenService.issueTokenPair(
      user,
      payload.sid,
    );
    await this.families.rotate({
      familyId: payload.sid,
      userId: user.id,
      tokenVersion: payload.tokenVersion,
      refreshToken,
      nextRefreshToken: tokens.refreshToken,
      expiresAt: tokens.refreshTokenExpiresAt,
    });
    return { ...tokens, user: toPublicAuthUser(user) };
  }

  async logout(userId: string, familyId: string): Promise<void> {
    await this.families.revokeFamily({ userId, familyId });
  }

  async changePassword(
    userId: string,
    tokenVersion: number,
    currentPassword: string,
    newPassword: string,
    familyId: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: authContextUserSelect,
    });

    if (
      !user ||
      !user.isActive ||
      user.mustChangePassword ||
      user.tokenVersion !== tokenVersion
    ) {
      throw new UnauthorizedException(INVALID_ACCESS_TOKEN);
    }

    const currentPasswordIsValid = await this.passwordHasherService.verify(
      currentPassword,
      user.passwordHash,
    );

    if (!currentPasswordIsValid) {
      throw new UnauthorizedException(INVALID_CURRENT_PASSWORD);
    }

    const newPasswordMatchesCurrent = await this.passwordHasherService.verify(
      newPassword,
      user.passwordHash,
    );

    if (newPasswordMatchesCurrent) {
      throw new BadRequestException(NEW_PASSWORD_MUST_BE_DIFFERENT);
    }

    const newPasswordHash = await this.passwordHasherService.hash(newPassword);

    await this.prisma.$transaction(async (tx) => {
      await this.authority.assertActiveSystemActor(
        tx,
        {
          id: user.id,
          email: user.email,
          role: user.role,
          tokenVersion,
          familyId,
        },
        [SystemRole.OWNER, SystemRole.MANAGER, SystemRole.MEMBER],
      );

      const updated = await tx.user.updateMany({
        where: {
          id: user.id,
          isActive: true,
          mustChangePassword: false,
          tokenVersion,
        },
        data: {
          passwordHash: newPasswordHash,
          refreshTokenHash: null,
          tokenVersion: { increment: 1 },
        },
      });
      if (updated.count !== 1)
        throw new UnauthorizedException(INVALID_ACCESS_TOKEN);

      const family = await tx.authSession.findUnique({
        where: { id: familyId },
        select: { expiresAt: true },
      });
      if (!family || family.expiresAt.getTime() <= Date.now())
        throw new UnauthorizedException(INVALID_ACCESS_TOKEN);
    });

    await this.authSessionService.clearCache(user.id);
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, tokenVersion: true, role: true, isActive: true },
    });

    const account = user
      ? { userId: user.id, tokenVersion: user.tokenVersion }
      : { userId: randomUUID(), tokenVersion: 0 };
    await this.queueProducerService.enqueuePasswordResetEmail(email, account);
  }

  async resetPassword(resetToken: string, newPassword: string): Promise<void> {
    const { userId, tokenVersion } =
      await this.passwordResetTokenService.consume(resetToken);

    const newPasswordHash = await this.passwordHasherService.hash(newPassword);

    const updateResult = await this.prisma.user.updateMany({
      where: {
        id: userId,
        tokenVersion,
        isActive: true,
        mustChangePassword: false,
        role: { not: SystemRole.OWNER },
      },
      data: {
        passwordHash: newPasswordHash,
        refreshTokenHash: null,
        tokenVersion: {
          increment: 1,
        },
      },
    });

    if (updateResult.count !== 1) {
      throw new BadRequestException(INVALID_PASSWORD_RESET_TOKEN);
    }

    await this.authSessionService.clearCache(userId);
  }
}
