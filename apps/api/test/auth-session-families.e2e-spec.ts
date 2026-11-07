import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService, SystemRole } from '@meetwise/infrastructure/database';
import { SessionFamilyService } from '../src/modules/auth/services/session-family.service';
import { RefreshTokenHasherService } from '../src/modules/auth/services/refresh-token-hasher.service';
import {
  prepareSessionDatabase,
  SESSION_SETUP_TIMEOUT_MS,
} from '../../../test/fixtures/auth-session-database';

describe('Per-device session families (real PostgreSQL)', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let families: SessionFamilyService;
  let userId: string;
  let otherUserId: string;
  const secret = randomBytes(48).toString('hex');
  const expires = () => new Date(Date.now() + 60_000);
  const token = () => randomBytes(48).toString('hex');
  const identity = (familyId: string, id = userId, tokenVersion = 0) => ({
    familyId,
    userId: id,
    tokenVersion,
  });
  const start = async (id = userId) => {
    const familyId = randomUUID();
    const refreshToken = token();
    await families.create({
      ...identity(familyId, id),
      refreshToken,
      expiresAt: expires(),
    });
    return { familyId, refreshToken };
  };
  beforeAll(async () => {
    await prepareSessionDatabase();
    module = await Test.createTestingModule({
      providers: [
        PrismaService,
        SessionFamilyService,
        RefreshTokenHasherService,
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_REFRESH_SECRET: secret }),
        },
      ],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    families = module.get(SessionFamilyService);
  }, SESSION_SETUP_TIMEOUT_MS);
  beforeEach(async () => {
    const createUser = () =>
      prisma.user.create({
        data: {
          email: `${randomUUID()}@example.invalid`,
          name: 'Synthetic session test',
          passwordHash: 'synthetic-unusable-password-hash',
          role: SystemRole.MEMBER,
        },
      });
    userId = (await createUser()).id;
    otherUserId = (await createUser()).id;
  });
  afterEach(async () => {
    await prisma.authSession.deleteMany({
      where: { userId: { in: [userId, otherUserId] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [userId, otherUserId] } },
    });
  });
  afterAll(async () => {
    await module?.close();
  });

  it('persists only a digest and keeps two devices independently valid', async () => {
    const a = await start();
    const b = await start();
    const row = await prisma.authSession.findUniqueOrThrow({
      where: { id: a.familyId },
    });
    expect(row.refreshHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(a.refreshToken);
    expect(await families.isValid(identity(a.familyId))).toBe(true);
    expect(await families.isValid(identity(b.familyId))).toBe(true);
  });
  it('rotates atomically, detects replay, and revokes only the affected family', async () => {
    const a = await start();
    const b = await start();
    await families.rotate({
      ...identity(a.familyId),
      refreshToken: a.refreshToken,
      nextRefreshToken: token(),
      expiresAt: expires(),
    });
    expect(
      (
        await prisma.authSession.findUniqueOrThrow({
          where: { id: a.familyId },
        })
      ).rotationCounter,
    ).toBe(1);
    await expect(
      families.rotate({
        ...identity(a.familyId),
        refreshToken: a.refreshToken,
        nextRefreshToken: token(),
        expiresAt: expires(),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await families.isValid(identity(a.familyId))).toBe(false);
    expect(await families.isValid(identity(b.familyId))).toBe(true);
  });
  it('allows at most one concurrent rotation and commits strict loser revocation', async () => {
    const a = await start();
    const attempts = await Promise.allSettled(
      [token(), token()].map((nextRefreshToken) =>
        families.rotate({
          ...identity(a.familyId),
          refreshToken: a.refreshToken,
          nextRefreshToken,
          expiresAt: expires(),
        }),
      ),
    );
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((a) => a.status === 'rejected')).toHaveLength(1);
    const row = await prisma.authSession.findUniqueOrThrow({
      where: { id: a.familyId },
    });
    expect(row.rotationCounter).toBe(1);
    expect(row.revokedAt).not.toBeNull();
  });
  it('cannot renew an expired family', async () => {
    const a = await start();
    const expiredAt = new Date(Date.now() - 1000);
    await prisma.authSession.update({
      where: { id: a.familyId },
      data: { expiresAt: expiredAt },
    });
    await expect(
      families.rotate({
        ...identity(a.familyId),
        refreshToken: a.refreshToken,
        nextRefreshToken: token(),
        expiresAt: expires(),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await families.isValid(identity(a.familyId))).toBe(false);
    expect(
      (
        await prisma.authSession.findUniqueOrThrow({
          where: { id: a.familyId },
        })
      ).expiresAt,
    ).toEqual(expiredAt);
  });
  it('logout is idempotent and isolates another device', async () => {
    const a = await start();
    const b = await start();
    await families.revokeFamily(identity(a.familyId));
    await families.revokeFamily(identity(a.familyId));
    expect(await families.isValid(identity(a.familyId))).toBe(false);
    expect(await families.isValid(identity(b.familyId))).toBe(true);
    await expect(
      families.rotate({
        ...identity(a.familyId),
        refreshToken: a.refreshToken,
        nextRefreshToken: token(),
        expiresAt: expires(),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('cross-user rotation and logout cannot revoke the rightful family', async () => {
    const a = await start();
    await expect(
      families.rotate({
        ...identity(a.familyId, otherUserId),
        refreshToken: a.refreshToken,
        nextRefreshToken: token(),
        expiresAt: expires(),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await families.revokeFamily(identity(a.familyId, otherUserId));
    expect(await families.isValid(identity(a.familyId, otherUserId))).toBe(
      false,
    );
    expect(await families.isValid(identity(a.familyId))).toBe(true);
  });
  it('denies inactive or stale-version accounts without extending their families', async () => {
    const a = await start();
    await prisma.user.update({
      where: { id: userId },
      data: { isActive: false },
    });
    expect(await families.isValid(identity(a.familyId))).toBe(false);
    await expect(
      families.rotate({
        ...identity(a.familyId),
        refreshToken: a.refreshToken,
        nextRefreshToken: token(),
        expiresAt: expires(),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await prisma.user.update({
      where: { id: userId },
      data: { isActive: true, tokenVersion: { increment: 1 } },
    });
    expect(await families.isValid(identity(a.familyId))).toBe(false);
    expect(await families.isValid(identity(a.familyId, userId, 1))).toBe(false);
  });
  it('revoke-all changes only the authenticated user families', async () => {
    const a = await start();
    const b = await start();
    const c = await start(otherUserId);
    await families.revokeAll(userId);
    expect(await families.isValid(identity(a.familyId))).toBe(false);
    expect(await families.isValid(identity(b.familyId))).toBe(false);
    expect(await families.isValid(identity(c.familyId, otherUserId))).toBe(
      true,
    );
  });
  it('denies unknown identities and rejects non-future expiration or no-op rotation', async () => {
    expect(await families.isValid(identity(randomUUID()))).toBe(false);
    expect(await families.isValid(identity('invalid'))).toBe(false);
    await expect(
      families.create({
        ...identity(randomUUID()),
        refreshToken: token(),
        expiresAt: new Date(0),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const a = await start();
    await expect(
      families.rotate({
        ...identity(a.familyId),
        refreshToken: a.refreshToken,
        nextRefreshToken: a.refreshToken,
        expiresAt: expires(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await families.isValid(identity(a.familyId))).toBe(true);
  });
  it('the database enforces foreign keys and blocks cascading user deletion', async () => {
    await start();
    await expect(
      prisma.user.delete({ where: { id: userId } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      prisma.authSession.create({
        data: {
          id: randomUUID(),
          userId: randomUUID(),
          refreshHash: randomBytes(32).toString('hex'),
          tokenVersion: 0,
          expiresAt: expires(),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
