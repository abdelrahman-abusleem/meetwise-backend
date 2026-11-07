import {
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
import { MeetingVisibilityPolicy } from '../../../../../libs/meetings/src/domain/meeting-visibility.policy';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ActorAuthorityService } from '../auth/services/actor-authority.service';

interface MeetingMetadataRow {
  id: string;
  kind: string;
  departmentId: string | null;
  visibility: string;
  title: string;
  createdById: string;
  meetingAdminId: string;
  lifecycle: string;
  version: number;
  scheduleVersion: number;
  scheduledAt: Date | null;
}

@Injectable()
export class MeetingReadService {
  private readonly visibility = new MeetingVisibilityPolicy();
  constructor(
    private readonly db: PrismaService,
    private readonly authority: ActorAuthorityService,
  ) {}

  async metadata(actor: AuthenticatedUser, id: string) {
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
          const rows = await tx.$queryRaw<MeetingMetadataRow[]>`
          SELECT id,kind,department_id AS "departmentId",visibility,title,
          created_by_id AS "createdById",meeting_admin_id AS "meetingAdminId",lifecycle,
          version,schedule_version AS "scheduleVersion",scheduled_at AS "scheduledAt"
          FROM meetings WHERE id=${id}::uuid FOR SHARE`;
          const meeting = rows[0];
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
          FROM meeting_access WHERE meeting_id=${id}::uuid AND user_id=${actor.id}::uuid FOR SHARE`;
          const decision = this.visibility.evaluate(
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
          if (!decision.allowed) throw new NotFoundException();

          const family = await tx.authSession.findUnique({
            where: { id: actor.familyId },
            select: { expiresAt: true },
          });
          if (!family || family.expiresAt.getTime() <= Date.now())
            throw new UnauthorizedException('Invalid session');
          return {
            ...meeting,
            scheduledAt: meeting.scheduledAt?.toISOString() ?? null,
          };
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
        throw new ServiceUnavailableException('Meeting service is unavailable');
      throw error;
    }
  }
}
