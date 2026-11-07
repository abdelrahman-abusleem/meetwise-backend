import type { OutboxEventEnvelope } from '../domain/outbox-dispatch.policy';

export interface OutboxPublishPort {
  publish(envelope: OutboxEventEnvelope): Promise<void>;
}
