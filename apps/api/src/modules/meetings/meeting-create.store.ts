import { Injectable } from '@nestjs/common';
import { Prisma } from '@meetwise/infrastructure/database';
import { randomUUID } from 'node:crypto';
import type { MeetingScope } from '../../../../../libs/meetings/src/domain/meeting-scope.policy';
import type { validateDraftMetadata } from './meeting-input';

export interface MeetingCreatedView {
  id: string;
  kind: string;
  departmentId: string | null;
  visibility: string;
  title: string;
  createdById: string;
  meetingAdminId: string;
  lifecycle: 'DRAFT';
  version: number;
  scheduleVersion: number;
  scheduledAt: string | null;
}

@Injectable()
export class MeetingCreateStore {
  async receipt(
    tx: Prisma.TransactionClient,
    actorId: string,
    keyHash: string,
  ) {
    const rows = await tx.$queryRaw<
      { payloadHash: string; response: MeetingCreatedView }[]
    >`
      SELECT payload_hash AS "payloadHash", response FROM meeting_create_requests
      WHERE actor_id=${actorId}::uuid AND key_hash=${keyHash}`;
    return rows[0];
  }

  async persist(
    tx: Prisma.TransactionClient,
    scope: Readonly<MeetingScope>,
    creatorId: string,
    managerId: string,
    metadata: ReturnType<typeof validateDraftMetadata>,
    identity: { keyHash: string; payloadHash: string },
  ): Promise<MeetingCreatedView> {
    const id = randomUUID();
    await tx.$executeRaw`
      INSERT INTO meetings(id,kind,department_id,visibility,title,created_by_id,meeting_admin_id,scheduled_at,time_zone,join_url)
      VALUES(${id}::uuid,${scope.kind},${scope.departmentId}::uuid,${scope.visibility},${metadata.title},${creatorId}::uuid,${managerId}::uuid,${metadata.scheduledAt},${metadata.timeZone},${metadata.joinUrl})`;
    await tx.$executeRaw`
      INSERT INTO meeting_access(meeting_id,user_id,role) VALUES(${id}::uuid,${managerId}::uuid,'MEETING_ADMIN')`;
    await tx.$executeRaw`
      INSERT INTO meeting_creation_audit(id,meeting_id,actor_id) VALUES(${randomUUID()}::uuid,${id}::uuid,${creatorId}::uuid)`;
    await tx.$executeRaw`
      INSERT INTO outbox_events(id,type,aggregate_id,aggregate_version,payload)
      VALUES(${randomUUID()}::uuid,'meeting.created.v1',${id}::uuid,0,${JSON.stringify({ meetingId: id })}::jsonb)`;
    const response: MeetingCreatedView = {
      id,
      kind: scope.kind,
      departmentId: scope.departmentId,
      visibility: scope.visibility,
      title: metadata.title,
      createdById: creatorId,
      meetingAdminId: managerId,
      lifecycle: 'DRAFT',
      version: 0,
      scheduleVersion: 0,
      scheduledAt: metadata.scheduledAt?.toISOString() ?? null,
    };
    await tx.$executeRaw`
      INSERT INTO meeting_create_requests(actor_id,key_hash,payload_hash,meeting_id,response)
      VALUES(${creatorId}::uuid,${identity.keyHash},${identity.payloadHash},${id}::uuid,${JSON.stringify(response)}::jsonb)`;
    return response;
  }
}
