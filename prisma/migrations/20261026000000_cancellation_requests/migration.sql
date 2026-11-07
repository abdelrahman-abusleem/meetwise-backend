-- Additive upgrade: no existing data is deleted or rewritten.
BEGIN;
CREATE TABLE cancellation_requests (
 id UUID PRIMARY KEY, meeting_id UUID NOT NULL, requested_by_id UUID NOT NULL,
 reason VARCHAR(1000) NOT NULL, status TEXT NOT NULL DEFAULT 'REQUESTED', version INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT cancellation_requests_reason_check CHECK(length(btrim(reason))>0),
 CONSTRAINT cancellation_requests_status_check CHECK(status IN ('REQUESTED','APPROVED','REJECTED','WITHDRAWN')),
 CONSTRAINT cancellation_requests_version_check CHECK(version>=0),
 CONSTRAINT cancellation_requests_meeting_id_fkey FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT cancellation_requests_requested_by_id_fkey FOREIGN KEY(requested_by_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX cancellation_requests_pending_meeting_key ON cancellation_requests(meeting_id) WHERE status='REQUESTED';
CREATE INDEX cancellation_requests_requested_by_id_idx ON cancellation_requests(requested_by_id);
CREATE TABLE cancellation_submissions (
 actor_id UUID NOT NULL, key_hash VARCHAR(64) NOT NULL, payload_hash VARCHAR(64) NOT NULL,
 request_id UUID NOT NULL, response JSONB NOT NULL, created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT cancellation_submissions_pkey PRIMARY KEY(actor_id,key_hash),
 CONSTRAINT cancellation_submissions_hash_check CHECK(key_hash ~ '^[a-f0-9]{64}$' AND payload_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT cancellation_submissions_response_check CHECK(jsonb_typeof(response)='object'),
 CONSTRAINT cancellation_submissions_actor_id_fkey FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT cancellation_submissions_request_id_fkey FOREIGN KEY(request_id) REFERENCES cancellation_requests(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE cancellation_request_audit (
 id UUID PRIMARY KEY, request_id UUID NOT NULL, actor_id UUID NOT NULL,
 action TEXT NOT NULL DEFAULT 'cancellation.requested.v1', created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT cancellation_request_audit_action_check CHECK(action='cancellation.requested.v1'),
 CONSTRAINT cancellation_request_audit_request_id_fkey FOREIGN KEY(request_id) REFERENCES cancellation_requests(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT cancellation_request_audit_actor_id_fkey FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX cancellation_request_audit_request_id_idx ON cancellation_request_audit(request_id);
-- Retain the old event invariant, adding only this ID-only notification intent.
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_creation_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_creation_check CHECK ((
 (type='meeting.created.v1' AND aggregate_version=0 AND payload=jsonb_build_object('meetingId',aggregate_id::text)) OR
 (type='cancellation.requested.v1' AND aggregate_version>=0
  AND jsonb_typeof(payload->'requestId')='string'
  AND (payload->>'requestId') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  AND payload=jsonb_build_object('meetingId',aggregate_id::text,'requestId',payload->>'requestId'))
) IS TRUE);
COMMIT;
