import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Prisma,
  PrismaService,
  SystemRole,
} from '@meetwise/infrastructure/database';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ActorAuthorityService } from '../auth/services/actor-authority.service';
import { MeetingScopePolicy } from '../../../../../libs/meetings/src/domain/meeting-scope.policy';
import {
  MeetingCreationPolicy,
  type MeetingUserFacts,
} from '../../../../../libs/meetings/src/domain/meeting-creation.policy';
import { CreateMeetingDto } from './create-meeting.dto';
import { meetingRequestIdentity, validateDraftMetadata } from './meeting-input';
import { MeetingCreateStore } from './meeting-create.store';

@Injectable()
export class MeetingCreateService {
  private readonly scopes = new MeetingScopePolicy();
  private readonly creation = new MeetingCreationPolicy();
  constructor(
    private readonly db: PrismaService,
    private readonly authority: ActorAuthorityService,
    private readonly store: MeetingCreateStore,
  ) {}

  async create(
    actor: AuthenticatedUser,
    input: CreateMeetingDto,
    key: unknown,
  ) {
    const metadata = validateDraftMetadata(input);
    const identity = meetingRequestIdentity(key, input);
    try {
      return await this.db.$transaction(
        async (tx) => {
          await this.authority.assertActiveSystemActor(
            tx,
            actor,
            [SystemRole.OWNER, SystemRole.MANAGER, SystemRole.MEMBER],
            input.meetingAdminId,
          );
          const creator = await tx.user.findUniqueOrThrow({
            where: { id: actor.id },
            select: { id: true, role: true, isActive: true },
          });
          if (
            !(await tx.systemSetting.findFirst({
              where: { singletonKey: 'system', setupCompleted: true },
              select: { id: true },
            }))
          )
            throw new NotFoundException();
          const department =
            input.departmentId === undefined
              ? null
              : ((
                  await tx.$queryRaw<
                    { id: string; kind: 'TECH' | 'SALES'; status: string }[]
                  >`
          SELECT id,kind,status FROM departments WHERE id=${input.departmentId}::uuid FOR UPDATE`
                )[0] ?? null);
          const grants =
            input.departmentId === undefined
              ? []
              : await tx.departmentMembership.findMany({
                  where: {
                    departmentId: input.departmentId,
                    userId: {
                      in: [actor.id, input.meetingAdminId ?? actor.id],
                    },
                    revokedAt: null,
                  },
                });
          const membership =
            grants.find((grant) => grant.userId === actor.id) ?? null;

          if (
            input.departmentId !== undefined &&
            (!department || (creator.role === SystemRole.MEMBER && !membership))
          )
            throw new NotFoundException();
          await this.assertSessionLive(tx, actor);
          const normalized = this.scopes.normalize(input, department);
          if (!normalized.ok)
            throw new UnprocessableEntityException('Invalid meeting scope');
          const preliminary = this.creation.decide(
            normalized.scope,
            creator,
            membership,
          );
          if (
            !preliminary.ok &&
            preliminary.reason !== 'ELIGIBLE_MANAGER_REQUIRED'
          )
            throw new ForbiddenException('Meeting creation is not permitted');
          if (
            preliminary.ok &&
            input.meetingAdminId !== undefined &&
            input.meetingAdminId !== actor.id
          )
            throw new ForbiddenException('Meeting creation is not permitted');
          if (department && department.status !== 'ACTIVE')
            throw new ConflictException('Department is not active');
          let manager: {
            user: MeetingUserFacts;
            membership: typeof membership;
          } | null = null;
          if (input.meetingAdminId !== undefined) {
            const user = await tx.user.findUnique({
              where: { id: input.meetingAdminId },
              select: { id: true, role: true, isActive: true },
            });
            if (!user)
              throw new UnprocessableEntityException(
                'Eligible meeting manager is required',
              );
            manager = {
              user,
              membership:
                grants.find((grant) => grant.userId === user.id) ?? null,
            };
          }
          const decision = this.creation.decide(
            normalized.scope,
            creator,
            membership,
            manager,
          );
          if (!decision.ok) {
            if (decision.reason === 'ELIGIBLE_MANAGER_REQUIRED')
              throw new UnprocessableEntityException(
                'Eligible meeting manager is required',
              );
            throw new ForbiddenException('Meeting creation is not permitted');
          }
          const receipt = await this.store.receipt(
            tx,
            actor.id,
            identity.keyHash,
          );
          if (receipt) {
            if (receipt.payloadHash !== identity.payloadHash)
              throw new ConflictException('Idempotency key payload conflict');
            await this.assertSessionLive(tx, actor);
            return receipt.response;
          }
          const result = await this.store.persist(
            tx,
            normalized.scope,
            decision.createdById,
            decision.meetingAdminId,
            metadata,
            identity,
          );

          await this.assertSessionLive(tx, actor);
          return result;
        },
        { timeout: 10000, maxWait: 5000 },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P1001', 'P1002', 'P2024', 'P2034'].includes(error.code)
      )
        throw new ServiceUnavailableException(
          'Meeting creation is temporarily unavailable',
        );
      throw error;
    }
  }

  private async assertSessionLive(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
  ) {
    const session = await tx.authSession.findUnique({
      where: { id: actor.familyId },
      select: { expiresAt: true },
    });
    if (!session || session.expiresAt.getTime() <= Date.now())
      throw new UnauthorizedException('Invalid session');
  }
}
