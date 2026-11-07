-- SOURCE PREPARED ONLY. Not executed or database verified.
-- Additive expansion; preserve historical migrations, existing rows and the
-- four-family outbox_events_creation_check, including its payload restrictions.
BEGIN;

ALTER TABLE outbox_events
 ADD COLUMN aggregate_type TEXT NOT NULL DEFAULT 'Meeting',
 ADD COLUMN event_version INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN correlation_id TEXT,
 ADD COLUMN causation_id TEXT,
 ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN next_retry_at TIMESTAMPTZ(3),
 ADD COLUMN locked_by TEXT,
 ADD COLUMN locked_until TIMESTAMPTZ(3);

ALTER TABLE outbox_events
 ADD CONSTRAINT outbox_dispatch_version_check CHECK(event_version=1),
 ADD CONSTRAINT outbox_dispatch_aggregate_check CHECK(aggregate_type='Meeting'),
 ADD CONSTRAINT outbox_dispatch_attempts_check CHECK(attempts>=0),
 ADD CONSTRAINT outbox_dispatch_lease_pair_check CHECK((locked_by IS NULL)=(locked_until IS NULL)),
 ADD CONSTRAINT outbox_dispatch_lease_token_check CHECK(locked_by IS NULL OR length(btrim(locked_by))>0),
 ADD CONSTRAINT outbox_dispatch_trace_check CHECK(
  (correlation_id IS NULL OR length(btrim(correlation_id))>0) AND
  (causation_id IS NULL OR length(btrim(causation_id))>0));

CREATE INDEX outbox_dispatch_due_idx ON outbox_events(dispatched_at,next_retry_at,created_at,id);

CREATE TABLE inbox_receipts (
 id TEXT NOT NULL,
 consumer TEXT NOT NULL,
 event_id TEXT NOT NULL,
 source_outbox_event_id UUID,
 processed_at TIMESTAMPTZ(3) NOT NULL,
 outcome TEXT NOT NULL,
 CONSTRAINT inbox_receipts_pkey PRIMARY KEY(id),
 CONSTRAINT inbox_receipts_consumer_event_key UNIQUE(consumer,event_id),
 CONSTRAINT inbox_receipts_identity_check CHECK(length(btrim(id))>0 AND length(btrim(consumer))>0),
 CONSTRAINT inbox_receipts_source_outbox_event_id_fkey FOREIGN KEY(source_outbox_event_id) REFERENCES outbox_events(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE notifications (
 id TEXT NOT NULL,
 recipient_user_id UUID NOT NULL,
 kind TEXT NOT NULL,
 resource_id TEXT NOT NULL,
 body_safe TEXT NOT NULL,
 state TEXT NOT NULL,
 created_at TIMESTAMPTZ(3) NOT NULL,
 seen_at TIMESTAMPTZ(3),
 CONSTRAINT notifications_pkey PRIMARY KEY(id),
 CONSTRAINT notifications_recipient_user_id_fkey FOREIGN KEY(recipient_user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT notifications_identity_check CHECK(length(btrim(id))>0 AND length(btrim(resource_id))>0),
 CONSTRAINT notifications_body_check CHECK(length(btrim(body_safe))>0),
 CONSTRAINT notifications_kind_check CHECK(kind IN ('meeting.created.v1','meeting.cancelled.v1','meeting.manager_transferred.v1','analysis.finished.v1','execution.unknown.v1','execution.succeeded.v1')),
 CONSTRAINT notifications_seen_state_check CHECK((state='UNREAD' AND seen_at IS NULL) OR (state='READ' AND seen_at IS NOT NULL))
);
CREATE INDEX notifications_recipient_page_idx ON notifications(recipient_user_id,seen_at,created_at,id);

CREATE TABLE notification_deliveries (
 id TEXT NOT NULL,
 notification_id TEXT NOT NULL,
 channel TEXT NOT NULL,
 attempt INTEGER NOT NULL,
 status TEXT NOT NULL,
 external_message_id TEXT,
 CONSTRAINT notification_deliveries_pkey PRIMARY KEY(id),
 CONSTRAINT notification_deliveries_notification_id_fkey FOREIGN KEY(notification_id) REFERENCES notifications(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT notification_deliveries_channel_attempt_key UNIQUE(notification_id,channel,attempt),
 CONSTRAINT notification_deliveries_identity_check CHECK(length(btrim(id))>0),
 CONSTRAINT notification_deliveries_channel_check CHECK(channel IN ('IN_APP','SMTP')),
 CONSTRAINT notification_deliveries_attempt_check CHECK(attempt>=1),
 CONSTRAINT notification_deliveries_status_check CHECK(status IN ('PENDING','SENT','RETRYABLE_NO_EFFECT','PERMANENTLY_FAILED','UNKNOWN_EFFECT'))
);

COMMIT;
