import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  DepartmentKind,
  DepartmentStatus,
  PrismaService,
  SystemRole,
  type Prisma,
} from '@meetwise/infrastructure/database';
import { ActorAuthorityService } from '../auth/services/actor-authority.service';
import type { AuthenticatedUser } from '../auth/auth.types';

const SYSTEM_SINGLETON_KEY = 'system';

const moduleState = (row: {
  id: string;
  kind: DepartmentKind;
  status: DepartmentStatus;
  version: number;
}) => ({
  kind: row.kind,
  status: row.status,
  version: row.version,
  departmentId: row.id,
});

const absentState = (kind: DepartmentKind) => ({
  kind,
  status: DepartmentStatus.DISABLED,
  version: null,
  departmentId: null,
});

@Injectable()
export class DepartmentModulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authority: ActorAuthorityService,
  ) {}

  async list() {
    await this.requireInitializedInstallation();
    const rows = await this.prisma.department.findMany({
      select: { id: true, kind: true, status: true, version: true },
      orderBy: { kind: 'asc' },
    });
    return {
      modules: (
        [DepartmentKind.TECH, DepartmentKind.SALES] as DepartmentKind[]
      ).map((kind) => {
        const row = rows.find((candidate) => candidate.kind === kind);
        return row ? moduleState(row) : absentState(kind);
      }),
    };
  }

  async enable(actor: AuthenticatedUser, kind: DepartmentKind) {
    return this.prisma.$transaction(async (tx) => {
      await this.authority.assertActiveSystemActor(tx, actor, [
        SystemRole.OWNER,
        SystemRole.MANAGER,
      ]);

      await tx.$queryRaw`SELECT id FROM system_settings WHERE singleton_key='system' FOR UPDATE`;
      const family = await tx.authSession.findUnique({
        where: { id: actor.familyId },
        select: { expiresAt: true },
      });
      if (!family || family.expiresAt.getTime() <= Date.now())
        throw new UnauthorizedException('Invalid session');
      const settings = await tx.systemSetting.findFirst({
        where: { singletonKey: SYSTEM_SINGLETON_KEY, setupCompleted: true },
        select: { id: true },
      });
      if (!settings)
        throw new NotFoundException('Installation is not initialized');

      const created = await tx.$queryRaw<
        {
          id: string;
          kind: DepartmentKind;
          status: DepartmentStatus;
          version: number;
        }[]
      >`
        INSERT INTO departments ("id", "kind", "status", "version")
        VALUES (${randomUUID()}::uuid, ${kind}::"DepartmentKind", 'ACTIVE', 1)
        ON CONFLICT ("kind") DO NOTHING
        RETURNING "id", "kind", "status", "version"`;
      const createdRow = created[0];
      if (createdRow) {
        await tx.departmentActivationEvent.create({
          data: {
            actorId: actor.id,
            departmentId: createdRow.id,
            toStatus: DepartmentStatus.ACTIVE,
            version: 1,
          },
        });
        return this.authorizedState(tx, actor, createdRow);
      }
      const row = await tx.department.findUniqueOrThrow({
        where: { kind },
        select: { id: true, kind: true, status: true, version: true },
      });
      if (row.status === DepartmentStatus.ACTIVE)
        return this.authorizedState(tx, actor, row);

      const flipped = await tx.department.updateMany({
        where: {
          id: row.id,
          status: DepartmentStatus.DISABLED,
          version: row.version,
        },
        data: { status: DepartmentStatus.ACTIVE, version: { increment: 1 } },
      });
      if (flipped.count !== 1) {
        const current = await tx.department.findUniqueOrThrow({
          where: { kind },
          select: { id: true, kind: true, status: true, version: true },
        });
        if (current.status === DepartmentStatus.ACTIVE)
          return this.authorizedState(tx, actor, current);
        throw new ConflictException('Module state changed concurrently');
      }
      await tx.departmentActivationEvent.create({
        data: {
          actorId: actor.id,
          departmentId: row.id,
          fromStatus: row.status,
          toStatus: DepartmentStatus.ACTIVE,
          version: row.version + 1,
        },
      });
      return this.authorizedState(tx, actor, {
        ...row,
        status: DepartmentStatus.ACTIVE,
        version: row.version + 1,
      });
    });
  }

  private async authorizedState(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    row: Parameters<typeof moduleState>[0],
  ) {
    await this.authority.assertActiveSystemActor(tx, actor, [
      SystemRole.OWNER,
      SystemRole.MANAGER,
    ]);
    return moduleState(row);
  }

  private async requireInitializedInstallation() {
    const settings = await this.prisma.systemSetting.findFirst({
      where: { singletonKey: SYSTEM_SINGLETON_KEY, setupCompleted: true },
      select: { id: true },
    });
    if (!settings)
      throw new NotFoundException('Installation is not initialized');
  }
}
