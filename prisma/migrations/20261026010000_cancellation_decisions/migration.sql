-- Additive upgrade; preserve existing requests and all historical records.
BEGIN;
ALTER TABLE cancellation_requests ADD COLUMN decided_by_id UUID, ADD COLUMN decision_at TIMESTAMPTZ(3), ADD COLUMN decision_reason VARCHAR(1000);
ALTER TABLE cancellation_requests ADD CONSTRAINT cancellation_requests_decided_by_id_fkey FOREIGN KEY(decided_by_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE cancellation_requests ADD CONSTRAINT cancellation_requests_decision_pair_check CHECK((decided_by_id IS NULL)=(decision_at IS NULL));
ALTER TABLE cancellation_requests ADD CONSTRAINT cancellation_requests_decision_reason_check CHECK(decision_reason IS NULL OR length(btrim(decision_reason))>0);
CREATE INDEX cancellation_requests_decided_by_id_idx ON cancellation_requests(decided_by_id);
CREATE TABLE cancellation_decisions (
 actor_id UUID NOT NULL,key_hash VARCHAR(64) NOT NULL,payload_hash VARCHAR(64) NOT NULL,
 request_id UUID NOT NULL,response JSONB NOT NULL,created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT cancellation_decisions_pkey PRIMARY KEY(actor_id,key_hash),
 CONSTRAINT cancellation_decisions_hash_check CHECK(key_hash ~ '^[a-f0-9]{64}$' AND payload_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT cancellation_decisions_response_check CHECK(jsonb_typeof(response)='object'),
 CONSTRAINT cancellation_decisions_actor_id_fkey FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT cancellation_decisions_request_id_fkey FOREIGN KEY(request_id) REFERENCES cancellation_requests(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE cancellation_request_audit DROP CONSTRAINT cancellation_request_audit_action_check;
ALTER TABLE cancellation_request_audit ADD CONSTRAINT cancellation_request_audit_action_check CHECK(action IN ('cancellation.requested.v1','cancellation.approved.v1','cancellation.rejected.v1'));
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_creation_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_creation_check CHECK ((
 (type='meeting.created.v1' AND aggregate_version=0 AND payload=jsonb_build_object('meetingId',aggregate_id::text)) OR
 (type IN ('cancellation.requested.v1','cancellation.decided.v1') AND aggregate_version>=0
  AND jsonb_typeof(payload->'requestId')='string'
  AND (payload->>'requestId') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  AND payload=jsonb_build_object('meetingId',aggregate_id::text,'requestId',payload->>'requestId')) OR
 (type='meeting.cancelled.v1' AND aggregate_version>=1
  AND jsonb_typeof(payload->'scheduleVersion')='number'
  AND (payload->>'scheduleVersion') ~ '^[1-9][0-9]*$'
  AND payload=jsonb_build_object('meetingId',aggregate_id::text,'scheduleVersion',payload->'scheduleVersion'))
) IS TRUE);
COMMIT;
