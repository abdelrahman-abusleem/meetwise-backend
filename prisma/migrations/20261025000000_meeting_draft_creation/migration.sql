-- Additive only. Historical migrations and records are preserved.
BEGIN;
CREATE TABLE meetings (
 id UUID PRIMARY KEY, kind TEXT NOT NULL, department_id UUID,
 visibility TEXT NOT NULL, title VARCHAR(240) NOT NULL,
 created_by_id UUID NOT NULL, meeting_admin_id UUID NOT NULL,
 lifecycle TEXT NOT NULL DEFAULT 'DRAFT', version INTEGER NOT NULL DEFAULT 0,
 schedule_version INTEGER NOT NULL DEFAULT 0, scheduled_at TIMESTAMPTZ(3),
 time_zone VARCHAR(80), join_url VARCHAR(1000), created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT meetings_kind_scope_check CHECK ((kind='GENERAL' AND department_id IS NULL AND visibility IN ('COMPANY','PRIVATE')) OR (kind IN ('TECH','SALES') AND department_id IS NOT NULL AND visibility IN ('DEPARTMENT','PRIVATE'))),
 CONSTRAINT meetings_lifecycle_check CHECK (lifecycle IN ('DRAFT','SCHEDULED','IN_PROGRESS','ENDED','CANCELLED')),
 CONSTRAINT meetings_versions_check CHECK (version>=0 AND schedule_version>=0),
 CONSTRAINT meetings_title_check CHECK (length(btrim(title))>0),
 CONSTRAINT meetings_created_by_id_fkey FOREIGN KEY(created_by_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT meetings_meeting_admin_id_fkey FOREIGN KEY(meeting_admin_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT meetings_department_id_fkey FOREIGN KEY(department_id) REFERENCES departments(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX meetings_department_id_created_at_id_idx ON meetings(department_id,created_at,id);
CREATE INDEX meetings_meeting_admin_id_lifecycle_idx ON meetings(meeting_admin_id,lifecycle);
CREATE TABLE meeting_access (
 meeting_id UUID NOT NULL, user_id UUID NOT NULL, role TEXT NOT NULL,
 can_read_transcript BOOLEAN NOT NULL DEFAULT FALSE,
 CONSTRAINT meeting_access_pkey PRIMARY KEY(meeting_id,user_id),
 CONSTRAINT meeting_access_role_check CHECK(role IN ('MEETING_ADMIN','REVIEWER','APPROVER','VIEWER')),
 CONSTRAINT meeting_access_meeting_id_fkey FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT meeting_access_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
-- A draft cannot commit without its manager's access entry; both inserts are atomic.
ALTER TABLE meetings ADD CONSTRAINT meetings_id_meeting_admin_id_fkey
 FOREIGN KEY(id,meeting_admin_id) REFERENCES meeting_access(meeting_id,user_id)
 ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE meeting_create_requests (
 actor_id UUID NOT NULL, key_hash VARCHAR(64) NOT NULL, payload_hash VARCHAR(64) NOT NULL,
 meeting_id UUID NOT NULL, response JSONB NOT NULL, created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT meeting_create_requests_pkey PRIMARY KEY(actor_id,key_hash),
 CONSTRAINT meeting_create_requests_hash_check CHECK(key_hash ~ '^[a-f0-9]{64}$' AND payload_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT meeting_create_requests_response_check CHECK(jsonb_typeof(response)='object'),
 CONSTRAINT meeting_create_requests_actor_id_fkey FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT meeting_create_requests_meeting_id_fkey FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE meeting_creation_audit (
 id UUID PRIMARY KEY, meeting_id UUID NOT NULL, actor_id UUID NOT NULL,
 action TEXT NOT NULL DEFAULT 'meeting.created.v1', created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT meeting_creation_audit_action_check CHECK(action='meeting.created.v1'),
 CONSTRAINT meeting_creation_audit_actor_id_fkey FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT meeting_creation_audit_meeting_id_fkey FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX meeting_creation_audit_meeting_id_idx ON meeting_creation_audit(meeting_id);
CREATE TABLE outbox_events (
 id UUID PRIMARY KEY, type TEXT NOT NULL, aggregate_id UUID NOT NULL,
 aggregate_version INTEGER NOT NULL, payload JSONB NOT NULL,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, dispatched_at TIMESTAMPTZ(3),
 CONSTRAINT outbox_events_creation_check CHECK(type='meeting.created.v1' AND aggregate_version=0 AND payload=jsonb_build_object('meetingId',aggregate_id::text))
);
CREATE INDEX outbox_events_dispatched_at_created_at_id_idx ON outbox_events(dispatched_at,created_at,id);
CREATE FUNCTION enforce_meeting_scope_and_creator() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE department_kind TEXT;
BEGIN
 IF TG_OP='UPDATE' AND NEW.created_by_id IS DISTINCT FROM OLD.created_by_id THEN
  RAISE EXCEPTION 'Meeting creator is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.department_id IS NOT NULL THEN
  SELECT kind::text INTO department_kind FROM departments WHERE id=NEW.department_id FOR KEY SHARE;
  IF department_kind IS DISTINCT FROM NEW.kind THEN
   RAISE EXCEPTION 'Meeting department kind mismatch' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meeting_scope_creator_guard BEFORE INSERT OR UPDATE ON meetings
 FOR EACH ROW EXECUTE FUNCTION enforce_meeting_scope_and_creator();
CREATE FUNCTION preserve_meeting_department_kind() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind IS DISTINCT FROM OLD.kind AND EXISTS(SELECT 1 FROM meetings WHERE department_id=OLD.id AND kind<>NEW.kind::text) THEN
  RAISE EXCEPTION 'Department kind conflicts with existing meetings' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER department_meeting_kind_guard BEFORE UPDATE OF kind ON departments
 FOR EACH ROW EXECUTE FUNCTION preserve_meeting_department_kind();
COMMIT;
