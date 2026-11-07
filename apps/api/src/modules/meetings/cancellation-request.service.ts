import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  Prisma,
  PrismaService,
  SystemRole,
} from '@meetwise/infrastructure/database';
import { createHash } from 'node:crypto';
import { CancellationRequestPolicy } from '../../../../../libs/meetings/src/domain/cancellation-request.policy';
import { MeetingVisibilityPolicy } from '../../../../../libs/meetings/src/domain/meeting-visibility.policy';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ActorAuthorityService } from '../auth/services/actor-authority.service';
import { CancellationRequestDto } from './cancellation-request.dto';
import { CancellationRequestStore } from './cancellation-request.store';

interface RequestMeeting {
  id: string;
  kind: string;
  departmentId: string | null;
  visibility: string;
  createdById: string;
  meetingAdminId: string;
  lifecycle: string;
  version: number;
}

@Injectable()
export class CancellationRequestService {
  private readonly policy = new CancellationRequestPolicy();
  private readonly visibility = new MeetingVisibilityPolicy();
  constructor(
    private readonly db: PrismaService,
    private readonly authority: ActorAuthorityService,
    private readonly store: CancellationRequestStore,
  ) {}

  async submit(
    actor: AuthenticatedUser,
    meetingId: string,
    input: CancellationRequestDto,
    key: unknown,
  ) {
    const reason = input.reason.trim();
    if (
      !reason ||
      reason.length > 1000 ||
      typeof key !== 'string' ||
      !/^[\x21-\x7e]{1,128}$/.test(key)
    )
      throw new BadRequestException(
        'A valid request and Idempotency-Key are required',
      );
    const digest = (text: string) =>
      createHash('sha256').update(text).digest('hex');
    const identity = {
      keyHash: digest(key),
      payloadHash: digest(JSON.stringify({ meetingId, reason })),
    };
    try {
      return await this.db.$transaction(
        async (tx) => {
          await this.authority.assertActiveSystemActor(tx, actor, [
            SystemRole.OWNER,
            SystemRole.MANAGER,
            SystemRole.MEMBER,
          ]);
          const user = await tx.user.findUniqueOrThrow({
            where: { id: actor.id },
            select: { role: true, isActive: true },
          });
          const meeting = (
            await tx.$queryRaw<RequestMeeting[]>`
          SELECT id,kind,department_id AS "departmentId",visibility,created_by_id AS "createdById",
          meeting_admin_id AS "meetingAdminId",lifecycle,version FROM meetings WHERE id=${meetingId}::uuid FOR UPDATE`
          )[0];
          if (!meeting) throw new NotFoundException();
          const memberships =
            meeting.departmentId === null
              ? []
              : await tx.$queryRaw<{ departmentId: string; role: string }[]>`
          SELECT department_id AS "departmentId",role FROM department_memberships
          WHERE department_id=${meeting.departmentId}::uuid AND user_id=${actor.id}::uuid AND revoked_at IS NULL FOR SHARE`;
          const access = await tx.$queryRaw<
            { meetingId: string; role: string; canReadTranscript: boolean }[]
          >`
          SELECT meeting_id AS "meetingId",role,can_read_transcript AS "canReadTranscript"
          FROM meeting_access WHERE meeting_id=${meetingId}::uuid AND user_id=${actor.id}::uuid FOR SHARE`;
          const visible = this.visibility.evaluate(
            {
              systemRole: user.role,
              isActive: user.isActive,
              departmentMemberships: memberships.map((row) => ({
                ...row,
                status: 'ACTIVE',
              })),
              meetingAccess: access,
            },
            meeting,
            'VIEW_METADATA',
          );
          const mayRequest =
            user.role === SystemRole.OWNER ||
            user.role === SystemRole.MANAGER ||
            memberships.some((row) => row.role === 'ADMIN') ||
            meeting.createdById === actor.id ||
            meeting.meetingAdminId === actor.id ||
            access.some((row) =>
              ['MEETING_ADMIN', 'REVIEWER', 'APPROVER'].includes(row.role),
            );
          if (!visible.allowed || !mayRequest) throw new NotFoundException();
          await this.assertSessionLive(tx, actor);

          const prior = await this.store.receipt(
            tx,
            actor.id,
            identity.keyHash,
          );
          if (prior) {
            if (prior.payloadHash !== identity.payloadHash)
              throw new ConflictException('Idempotency key payload conflict');
            await this.assertSessionLive(tx, actor);
            return prior.response;
          }
          const decision = this.policy.evaluate({
            command: 'SUBMIT_REQUEST',
            currentState: 'REQUESTED',
            meetingLifecycle: meeting.lifecycle,
            actorAuthorized: true,
            idempotencyKeyProvided: true,
            activeRequestExists: await this.store.pending(tx, meetingId),
          });
          if (!decision.ok)
            throw new ConflictException(
              'Cancellation request is not available',
            );
          const result = await this.store.persist(
            tx,
            meetingId,
            actor.id,
            reason,
            identity,
            meeting.version,
          );
          await this.assertSessionLive(tx, actor);
          return result;
        },
        { timeout: 10000, maxWait: 5000 },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        [
          'P1001',
          'P1002',
          'P1008',
          'P1017',
          'P2024',
          'P2028',
          'P2034',
        ].includes(error.code)
      )
        throw new ServiceUnavailableException(
          'Cancellation request service is unavailable',
        );
      throw error;
    }
  }

  private async assertSessionLive(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
  ) {
    const family = await tx.authSession.findUnique({
      where: { id: actor.familyId },
      select: { expiresAt: true },
    });
    if (!family || family.expiresAt.getTime() <= Date.now())
      throw new UnauthorizedException('Invalid session');
  }
}
