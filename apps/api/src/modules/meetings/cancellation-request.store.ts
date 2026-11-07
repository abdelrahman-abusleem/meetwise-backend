import { Injectable } from '@nestjs/common';
import { Prisma } from '@meetwise/infrastructure/database';
import { randomUUID } from 'node:crypto';

export interface CancellationRequestView {
  id: string;
  meetingId: string;
  requestedById: string;
  status: 'REQUESTED';
  version: number;
}

@Injectable()
export class CancellationRequestStore {
  async receipt(
    tx: Prisma.TransactionClient,
    actorId: string,
    keyHash: string,
  ) {
    return (
      await tx.$queryRaw<
        { payloadHash: string; response: CancellationRequestView }[]
      >`
      SELECT payload_hash AS "payloadHash",response FROM cancellation_submissions
      WHERE actor_id=${actorId}::uuid AND key_hash=${keyHash}`
    )[0];
  }

  async pending(tx: Prisma.TransactionClient, meetingId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM cancellation_requests WHERE meeting_id=${meetingId}::uuid AND status='REQUESTED'`;
    return rows.length > 0;
  }

  async persist(
    tx: Prisma.TransactionClient,
    meetingId: string,
    actorId: string,
    reason: string,
    identity: { keyHash: string; payloadHash: string },
    meetingVersion: number,
  ): Promise<CancellationRequestView> {
    const id = randomUUID();
    await tx.$executeRaw`
      INSERT INTO cancellation_requests(id,meeting_id,requested_by_id,reason)
      VALUES(${id}::uuid,${meetingId}::uuid,${actorId}::uuid,${reason})`;
    await this.appendAudit(tx, id, actorId);
    await this.appendOutbox(tx, id, meetingId, meetingVersion);
    const response: CancellationRequestView = {
      id,
      meetingId,
      requestedById: actorId,
      status: 'REQUESTED',
      version: 0,
    };
    await tx.$executeRaw`
      INSERT INTO cancellation_submissions(actor_id,key_hash,payload_hash,request_id,response)
      VALUES(${actorId}::uuid,${identity.keyHash},${identity.payloadHash},${id}::uuid,${JSON.stringify(response)}::jsonb)`;
    return response;
  }

  async appendAudit(
    tx: Prisma.TransactionClient,
    requestId: string,
    actorId: string,
  ) {
    await tx.$executeRaw`
      INSERT INTO cancellation_request_audit(id,request_id,actor_id)
      VALUES(${randomUUID()}::uuid,${requestId}::uuid,${actorId}::uuid)`;
  }

  async appendOutbox(
    tx: Prisma.TransactionClient,
    requestId: string,
    meetingId: string,
    meetingVersion: number,
  ) {
    await tx.$executeRaw`
      INSERT INTO outbox_events(id,type,aggregate_id,aggregate_version,payload)
      VALUES(${randomUUID()}::uuid,'cancellation.requested.v1',${meetingId}::uuid,${meetingVersion},${JSON.stringify({ meetingId, requestId })}::jsonb)`;
  }
}
