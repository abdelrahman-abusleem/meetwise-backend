import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@meetwise/infrastructure/database';
import { randomUUID } from 'node:crypto';

export interface CurrentCancellation {
  id: string;
  meetingId: string;
  requestedById: string;
  status: string;
  version: number;
  reason: string;
}
export interface CancellationDecisionView {
  id: string;
  meetingId: string;
  requestedById: string;
  status: 'APPROVED' | 'REJECTED';
  version: number;
}
@Injectable()
export class CancellationDecisionStore {
  async locate(tx: Prisma.TransactionClient, id: string) {
    return (
      await tx.$queryRaw<
        { meetingId: string }[]
      >`SELECT meeting_id AS "meetingId" FROM cancellation_requests WHERE id=${id}::uuid`
    )[0];
  }
  async current(tx: Prisma.TransactionClient, id: string, meetingId: string) {
    return (
      await tx.$queryRaw<CurrentCancellation[]>`
      SELECT id,meeting_id AS "meetingId",requested_by_id AS "requestedById",status,version,reason
      FROM cancellation_requests WHERE id=${id}::uuid AND meeting_id=${meetingId}::uuid FOR UPDATE`
    )[0];
  }
  async receipt(
    tx: Prisma.TransactionClient,
    actorId: string,
    keyHash: string,
  ) {
    return (
      await tx.$queryRaw<
        { payloadHash: string; response: CancellationDecisionView }[]
      >`
      SELECT payload_hash AS "payloadHash",response FROM cancellation_decisions
      WHERE actor_id=${actorId}::uuid AND key_hash=${keyHash}`
    )[0];
  }
  async persist(
    tx: Prisma.TransactionClient,
    request: CurrentCancellation,
    actorId: string,
    status: 'APPROVED' | 'REJECTED',
    reason: string,
    identity: { keyHash: string; payloadHash: string },
    meeting: { version: number; scheduleVersion: number; lifecycle: string },
  ) {
    if (status === 'APPROVED') {
      const updated = await tx.$executeRaw`
        UPDATE meetings SET lifecycle='CANCELLED',version=version+1,schedule_version=schedule_version+1
        WHERE id=${request.meetingId}::uuid AND version=${meeting.version} AND schedule_version=${meeting.scheduleVersion} AND lifecycle=${meeting.lifecycle}`;
      if (updated !== 1) throw new ConflictException('Meeting version changed');
    }
    const updated = await tx.$executeRaw`
      UPDATE cancellation_requests SET status=${status},version=version+1,decided_by_id=${actorId}::uuid,
      decision_at=CURRENT_TIMESTAMP,decision_reason=${reason}
      WHERE id=${request.id}::uuid AND version=${request.version} AND status='REQUESTED'`;
    if (updated !== 1)
      throw new ConflictException('Cancellation request changed');
    await this.appendAudit(tx, request.id, actorId, status);
    await this.appendOutbox(
      tx,
      request.id,
      request.meetingId,
      meeting.version + (status === 'APPROVED' ? 1 : 0),
      status === 'APPROVED' ? meeting.scheduleVersion + 1 : undefined,
    );
    const response: CancellationDecisionView = {
      id: request.id,
      meetingId: request.meetingId,
      requestedById: request.requestedById,
      status,
      version: request.version + 1,
    };
    await tx.$executeRaw`
      INSERT INTO cancellation_decisions(actor_id,key_hash,payload_hash,request_id,response)
      VALUES(${actorId}::uuid,${identity.keyHash},${identity.payloadHash},${request.id}::uuid,${JSON.stringify(response)}::jsonb)`;
    return response;
  }
  async appendAudit(
    tx: Prisma.TransactionClient,
    requestId: string,
    actorId: string,
    status: 'APPROVED' | 'REJECTED',
  ) {
    const action =
      status === 'APPROVED'
        ? 'cancellation.approved.v1'
        : 'cancellation.rejected.v1';
    await tx.$executeRaw`INSERT INTO cancellation_request_audit(id,request_id,actor_id,action)
      VALUES(${randomUUID()}::uuid,${requestId}::uuid,${actorId}::uuid,${action})`;
  }
  async appendOutbox(
    tx: Prisma.TransactionClient,
    requestId: string,
    meetingId: string,
    version: number,
    cancelledScheduleVersion?: number,
  ) {
    await tx.$executeRaw`INSERT INTO outbox_events(id,type,aggregate_id,aggregate_version,payload)
      VALUES(${randomUUID()}::uuid,'cancellation.decided.v1',${meetingId}::uuid,${version},${JSON.stringify({ meetingId, requestId })}::jsonb)`;
    if (cancelledScheduleVersion !== undefined) {
      await tx.$executeRaw`INSERT INTO outbox_events(id,type,aggregate_id,aggregate_version,payload)
        VALUES(${randomUUID()}::uuid,'meeting.cancelled.v1',${meetingId}::uuid,${version},${JSON.stringify({ meetingId, scheduleVersion: cancelledScheduleVersion })}::jsonb)`;
    }
  }
}
