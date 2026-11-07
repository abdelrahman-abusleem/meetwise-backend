import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PreconditionFailedException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Prisma,
  PrismaService,
  SystemRole,
} from '@meetwise/infrastructure/database';
import { createHash } from 'node:crypto';
import { CancellationRequestPolicy } from '../../../../../libs/meetings/src/domain/cancellation-request.policy';
import { MeetingLifecyclePolicy } from '../../../../../libs/meetings/src/domain/meeting-lifecycle.policy';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ActorAuthorityService } from '../auth/services/actor-authority.service';
import { CancellationDecisionDto } from './cancellation-decision.dto';
import { CancellationDecisionStore } from './cancellation-decision.store';

@Injectable()
export class CancellationDecisionService {
  private readonly requests = new CancellationRequestPolicy();
  private readonly lifecycle = new MeetingLifecyclePolicy();
  constructor(
    private readonly db: PrismaService,
    private readonly authority: ActorAuthorityService,
    private readonly store: CancellationDecisionStore,
  ) {}

  async decide(
    actor: AuthenticatedUser,
    id: string,
    input: CancellationDecisionDto,
    key: unknown,
    ifMatch: unknown,
  ) {
    if (
      typeof key !== 'string' ||
      !/^[\x21-\x7e]{1,128}$/.test(key) ||
      typeof ifMatch !== 'string' ||
      !/^"(0|[1-9]\d{0,9})"$/.test(ifMatch)
    )
      throw new BadRequestException(
        'Valid Idempotency-Key and quoted If-Match are required',
      );
    const expectedVersion = Number(ifMatch.slice(1, -1));
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion > 2147483647)
      throw new BadRequestException('Invalid request version');
    const reason = input.reason?.trim() ?? null;
    const digest = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    const identity = {
      keyHash: digest(key),
      payloadHash: digest(
        JSON.stringify({
          id,
          expectedVersion,
          decision: input.decision,
          reason,
        }),
      ),
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
            select: { role: true },
          });
          const located = await this.store.locate(tx, id);
          if (!located) throw new NotFoundException();
          const meeting = (
            await tx.$queryRaw<
              {
                id: string;
                kind: string;
                departmentId: string | null;
                lifecycle: string;
                version: number;
                scheduleVersion: number;
              }[]
            >`
          SELECT id,kind,department_id AS "departmentId",lifecycle,version,schedule_version AS "scheduleVersion"
          FROM meetings WHERE id=${located.meetingId}::uuid FOR UPDATE`
          )[0];
          if (!meeting) throw new NotFoundException();
          const membership =
            meeting.departmentId === null
              ? []
              : await tx.$queryRaw<{ role: string }[]>`
          SELECT role FROM department_memberships WHERE department_id=${meeting.departmentId}::uuid AND user_id=${actor.id}::uuid AND revoked_at IS NULL FOR SHARE`;
          const authorized =
            user.role === SystemRole.OWNER ||
            user.role === SystemRole.MANAGER ||
            (meeting.kind !== 'GENERAL' &&
              membership.some((row) => row.role === 'ADMIN'));
          if (!authorized) throw new NotFoundException();
          const current = await this.store.current(tx, id, meeting.id);
          if (!current) throw new NotFoundException();
          await this.assertSessionLive(tx, actor);
          if (
            input.decision === 'REASSIGN' ||
            input.newMeetingAdminId !== undefined
          )
            throw new UnprocessableEntityException(
              'Reassignment is not implemented',
            );
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
          const decision = this.requests.evaluate({
            command:
              input.decision === 'APPROVE'
                ? 'APPROVE_REQUEST'
                : 'REJECT_REQUEST',
            currentState: current.status,
            meetingLifecycle: meeting.lifecycle,
            actorAuthorized: true,
            expectedRequestVersion: expectedVersion,
            currentRequestVersion: current.version,
            reason: reason ?? undefined,
          });
          if (!decision.ok) {
            if (decision.reason === 'REQUEST_VERSION_MISMATCH')
              throw new PreconditionFailedException(
                'Cancellation request version changed',
              );
            if (decision.reason === 'REJECTION_REASON_REQUIRED')
              throw new UnprocessableEntityException(
                'A rejection reason is required',
              );
            throw new ConflictException(
              'Cancellation request is not decidable',
            );
          }
          if (decision.appliesMw43StopSemantics)
            throw new ConflictException(
              'Capture-stop coordination is not yet available',
            );
          if (decision.cancelsBeforeStart) {
            const transition = this.lifecycle.evaluate({
              command: 'ADMIN_CANCEL',
              authorized: true,
              currentLifecycle: meeting.lifecycle,
              currentScheduleVersion: meeting.scheduleVersion,
              reason: reason || current.reason,
            });
            if (!transition.ok || transition.to !== 'CANCELLED')
              throw new ConflictException('Meeting is not cancellable');
          }
          const result = await this.store.persist(
            tx,
            current,
            actor.id,
            input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
            reason || current.reason,
            identity,
            meeting,
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
          'Cancellation decisions are unavailable',
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
