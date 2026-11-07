import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PreconditionFailedException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  Prisma,
  PrismaService,
  SystemRole,
  DepartmentRole,
  DepartmentStatus,
} from '@meetwise/infrastructure/database';
import { createHash } from 'node:crypto';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ActorAuthorityService } from '../auth/services/actor-authority.service';
import { MembershipGrantDto, MembershipPageDto } from './membership.dto';
import {
  isSystemMembershipOperator,
  mayManageMembership,
} from './membership.policy';
type Membership = Prisma.DepartmentMembershipGetPayload<Record<string, never>>;
type Action = 'CREATE' | 'UPDATE' | 'REVOKE';
function view(row: Membership) {
  return {
    departmentId: row.departmentId,
    userId: row.userId,
    role: row.role,
    canCreateMeetings: row.canCreateMeetings,
    canManageMeetings: row.canManageMeetings,
    canApproveMeetings: row.canApproveMeetings,
    version: row.version,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
@Injectable()
export class DepartmentMembershipsService {
  constructor(
    private readonly db: PrismaService,
    private readonly authority: ActorAuthorityService,
  ) {}

  async list(
    actor: AuthenticatedUser,
    departmentId: string,
    page: MembershipPageDto,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await this.authority.assertActiveSystemActor(tx, actor, [
          SystemRole.OWNER,
          SystemRole.MANAGER,
          SystemRole.MEMBER,
        ]);
        await this.scope(tx, actor, departmentId);
        const rows = await tx.departmentMembership.findMany({
          where: {
            departmentId,
            revokedAt: null,
            ...(page.cursor ? { id: { gt: page.cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take: page.limit + 1,
        });
        const more = rows.length > page.limit,
          items = rows.slice(0, page.limit);
        await this.assertSessionUnexpired(tx, actor);
        return {
          items: items.map(view),
          nextCursor: more ? items.at(-1)!.id : null,
        };
      },
      { timeout: 10000 },
    );
  }

  async change(
    actor: AuthenticatedUser,
    departmentId: string,
    userId: string,
    action: Action,
    grant: MembershipGrantDto | undefined,
    match: unknown,
    key: unknown,
  ) {
    const expected = this.version(match),
      requestHash = this.requestHash(key);
    return this.db.$transaction(
      async (tx) => {
        await this.authority.assertActiveSystemActor(
          tx,
          actor,
          [SystemRole.OWNER, SystemRole.MANAGER, SystemRole.MEMBER],
          userId,
        );
        const scope = await this.scope(tx, actor, departmentId);
        const current = await tx.departmentMembership.findUnique({
          where: { departmentId_userId: { departmentId, userId } },
        });
        const currentRole = current?.revokedAt ? undefined : current?.role;
        if (
          !mayManageMembership(
            scope.systemRole,
            scope.departmentRole,
            currentRole,
            grant?.role,
            actor.id === userId,
          )
        )
          throw new ForbiddenException('Membership change is not permitted');
        if (
          await tx.membershipEvent.findFirst({
            where: { actorId: actor.id, requestHash },
            select: { id: true },
          })
        )
          throw new ConflictException('Membership request already processed');
        if ((current?.version ?? 0) !== expected)
          throw new PreconditionFailedException('Membership version changed');
        if (action === 'CREATE' && current && !current.revokedAt)
          throw new ConflictException('Membership already exists');
        if (action !== 'CREATE' && !current) throw new NotFoundException();
        if (action === 'UPDATE' && current?.revokedAt)
          throw new ConflictException(
            'Explicit new grant required for revoked membership',
          );
        if (action === 'REVOKE' && current?.revokedAt) {
          await this.assertSessionUnexpired(tx, actor);
          return view(current);
        }
        if (expected >= 2147483647)
          throw new ConflictException('Membership version exhausted');
        const target = await tx.user.findUnique({ where: { id: userId } });
        if (!target) throw new NotFoundException();
        const losesManagement =
          current &&
          !current.revokedAt &&
          (current.role === DepartmentRole.ADMIN ||
            current.canManageMeetings) &&
          !isSystemMembershipOperator(target.role) &&
          (action === 'REVOKE' ||
            (grant?.role !== DepartmentRole.ADMIN &&
              grant?.canManageMeetings !== true));
        if (losesManagement) {
          const managed = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM meetings WHERE department_id=${departmentId}::uuid
            AND meeting_admin_id=${userId}::uuid AND lifecycle IN ('DRAFT','SCHEDULED','IN_PROGRESS') LIMIT 1`;
          if (managed.length)
            throw new ConflictException(
              'Transfer active meetings before revoking management',
            );
        }
        if (
          action !== 'REVOKE' &&
          (!target.isActive || target.mustChangePassword)
        )
          throw new ConflictException('Target account is not active');
        const state =
          action === 'REVOKE'
            ? { revokedAt: new Date() }
            : { ...grant!, revokedAt: null };
        const row = current
          ? await tx.departmentMembership.update({
              where: { id: current.id },
              data: { ...state, version: { increment: 1 } },
            })
          : await tx.departmentMembership.create({
              data: { departmentId, userId, ...grant! },
            });
        const result = view(row);
        await tx.membershipEvent.create({
          data: {
            departmentId,
            userId,
            actorId: actor.id,
            version: row.version,
            action:
              action === 'REVOKE'
                ? 'REVOKED'
                : action === 'CREATE'
                  ? 'GRANTED'
                  : 'UPDATED',
            requestHash,
            snapshot: result,
          },
        });

        await this.assertSessionUnexpired(tx, actor);
        return result;
      },
      { timeout: 10000 },
    );
  }

  private async scope(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    departmentId: string,
  ): Promise<{
    systemRole: SystemRole;
    departmentRole: DepartmentRole | undefined;
  }> {
    const departments = await tx.$queryRaw<
      { id: string; status: DepartmentStatus }[]
    >`SELECT id,status FROM departments WHERE id=${departmentId}::uuid FOR UPDATE`;
    const current = await tx.user.findUniqueOrThrow({
      where: { id: actor.id },
      select: { role: true },
    });
    const membership = await tx.departmentMembership.findFirst({
      where: { departmentId, userId: actor.id, revokedAt: null },
      select: { role: true },
    });
    if (
      !departments.length ||
      departments[0].status !== DepartmentStatus.ACTIVE ||
      (!isSystemMembershipOperator(current.role) &&
        membership?.role !== DepartmentRole.ADMIN)
    )
      throw new NotFoundException();
    if (
      !(await tx.systemSetting.findFirst({
        where: { singletonKey: 'system', setupCompleted: true },
        select: { id: true },
      }))
    )
      throw new NotFoundException();

    await this.assertSessionUnexpired(tx, actor);
    return { systemRole: current.role, departmentRole: membership?.role };
  }
  private async assertSessionUnexpired(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
  ): Promise<void> {
    const session = await tx.authSession.findUnique({
      where: { id: actor.familyId },
      select: { expiresAt: true },
    });
    if (!session || !(session.expiresAt.getTime() > Date.now()))
      throw new UnauthorizedException('Invalid session');
  }
  private version(value: unknown): number {
    if (typeof value !== 'string' || !/^"(0|[1-9][0-9]{0,9})"$/.test(value))
      throw new BadRequestException('Quoted If-Match version is required');
    const version = Number(value.slice(1, -1));
    if (version > 2147483647)
      throw new BadRequestException('Invalid membership version');
    return version;
  }
  private requestHash(value: unknown): string {
    if (typeof value !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(value))
      throw new BadRequestException('A valid Idempotency-Key is required');
    return createHash('sha256').update(value).digest('hex');
  }
}
