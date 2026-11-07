-- Additive offline ingestion storage. No provider ingress or destructive data conversion.
BEGIN;
CREATE TABLE bot_sessions (
 id UUID PRIMARY KEY, meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
 schedule_version INTEGER NOT NULL CHECK(schedule_version>=0),
 UNIQUE(id,meeting_id)
);
CREATE INDEX bot_sessions_meeting_idx ON bot_sessions(meeting_id);
CREATE TABLE transcript_inbox (
 id UUID PRIMARY KEY, meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
 bot_session_id UUID NOT NULL, provider TEXT NOT NULL CHECK(length(btrim(provider))>0),
 provider_event_id TEXT NOT NULL CHECK(length(btrim(provider_event_id))>0),
 verified_at TIMESTAMPTZ(3) NOT NULL, verifier_version TEXT NOT NULL CHECK(length(btrim(verifier_version))>0),
 encrypted_event JSONB NOT NULL CHECK(jsonb_typeof(encrypted_event)='object'),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(bot_session_id,meeting_id) REFERENCES bot_sessions(id,meeting_id) ON DELETE RESTRICT,
 UNIQUE(provider,provider_event_id), UNIQUE(id,meeting_id,bot_session_id)
);
CREATE INDEX transcript_inbox_meeting_idx ON transcript_inbox(meeting_id);
CREATE TABLE transcripts (
 id UUID PRIMARY KEY, meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
 bot_session_id UUID NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 state TEXT NOT NULL CHECK(state IN ('RECEIVING','PARTIAL','COMPLETE','INVALID','FAILED')),
 is_partial BOOLEAN NOT NULL, snapshot_hash VARCHAR(64) NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
 CHECK(is_partial=(state='PARTIAL')),
 FOREIGN KEY(bot_session_id,meeting_id) REFERENCES bot_sessions(id,meeting_id) ON DELETE RESTRICT,
 UNIQUE(meeting_id,revision), UNIQUE(id,meeting_id)
);
CREATE TABLE transcript_segments (
 id UUID PRIMARY KEY, meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
 bot_session_id UUID NOT NULL, event_id UUID NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0), start_ms BIGINT NOT NULL CHECK(start_ms>=0),
 end_ms BIGINT NOT NULL CHECK(end_ms>=start_ms),
 content_hash VARCHAR(64) NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), dedupe_hash VARCHAR(64) NOT NULL CHECK(dedupe_hash ~ '^[a-f0-9]{64}$'),
 FOREIGN KEY(event_id,meeting_id,bot_session_id) REFERENCES transcript_inbox(id,meeting_id,bot_session_id) ON DELETE RESTRICT,
 UNIQUE(meeting_id,ordinal), UNIQUE(bot_session_id,dedupe_hash), UNIQUE(id,meeting_id,ordinal)
);
CREATE TABLE transcript_revision_segments (
 transcript_id UUID NOT NULL, meeting_id UUID NOT NULL, segment_id UUID NOT NULL, ordinal INTEGER NOT NULL,
 PRIMARY KEY(transcript_id,ordinal), UNIQUE(transcript_id,segment_id),
 FOREIGN KEY(transcript_id,meeting_id) REFERENCES transcripts(id,meeting_id) ON DELETE RESTRICT,
 FOREIGN KEY(segment_id,meeting_id,ordinal) REFERENCES transcript_segments(id,meeting_id,ordinal) ON DELETE RESTRICT
);
CREATE TABLE transcript_inbox_receipts (
 consumer TEXT NOT NULL CHECK(consumer='transcript-ingest'),
 event_id UUID NOT NULL REFERENCES transcript_inbox(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(consumer,event_id)
);
CREATE TABLE transcript_processing_audit (
 id UUID PRIMARY KEY, event_id UUID NOT NULL REFERENCES transcript_inbox(id) ON DELETE RESTRICT,
 command TEXT NOT NULL CHECK(command IN ('INGEST_SEGMENT','MARK_PARTIAL','COMPLETE_TRANSACTION','QUARANTINE_MALFORMED','MARK_INGEST_FAILED','OBSERVE_CONTRADICTORY_FAILURE')),
 from_state TEXT NOT NULL CHECK(from_state IN ('NONE','RECEIVING','PARTIAL','COMPLETE','INVALID','FAILED')),
 to_state TEXT NOT NULL CHECK(to_state IN ('NONE','RECEIVING','PARTIAL','COMPLETE','INVALID','FAILED')),
 revision_before INTEGER NOT NULL CHECK(revision_before>=0), revision_after INTEGER NOT NULL CHECK(revision_after>=revision_before),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(event_id)
);
-- Evidence references must never silently resolve to replacement provider content.
CREATE FUNCTION reject_transcript_evidence_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Transcript evidence is immutable'; END;
$$;
CREATE TRIGGER transcript_inbox_immutable BEFORE UPDATE ON transcript_inbox FOR EACH ROW EXECUTE FUNCTION reject_transcript_evidence_update();
CREATE TRIGGER transcript_segment_immutable BEFORE UPDATE ON transcript_segments FOR EACH ROW EXECUTE FUNCTION reject_transcript_evidence_update();
CREATE TRIGGER transcript_membership_immutable BEFORE UPDATE ON transcript_revision_segments FOR EACH ROW EXECUTE FUNCTION reject_transcript_evidence_update();
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
  AND payload=jsonb_build_object('meetingId',aggregate_id::text,'scheduleVersion',payload->'scheduleVersion')) OR
 (type='transcript.revision_ready.v1' AND aggregate_version>=1
  AND jsonb_typeof(payload->'transcriptId')='string'
  AND (payload->>'transcriptId') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  AND payload=jsonb_build_object('meetingId',aggregate_id::text,'transcriptId',payload->>'transcriptId','revision',aggregate_version))
) IS TRUE);
COMMIT;
