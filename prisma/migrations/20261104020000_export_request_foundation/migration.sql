-- SOURCE ONLY: no export workflow, permission, expiry duration or delivery is enabled.
BEGIN;
CREATE TABLE export_requests (
 id UUID PRIMARY KEY,
 meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 requester_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 idempotency_key VARCHAR(128) NOT NULL CHECK(length(btrim(idempotency_key)) > 0),
 kind TEXT NOT NULL CHECK(kind IN ('SUMMARY','TRANSCRIPT','ANALYSIS')),
 format TEXT NOT NULL CHECK(format IN ('JSON','CSV','PDF')),
 status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','READY','FAILED','EXPIRED')),
 expires_at TIMESTAMPTZ(3),
 storage_key TEXT CHECK(storage_key IS NULL OR length(btrim(storage_key)) > 0),
 content_type TEXT CHECK(content_type IS NULL OR length(btrim(content_type)) > 0),
 byte_size BIGINT CHECK(byte_size IS NULL OR byte_size >= 0),
 content_sha256 VARCHAR(64) CHECK(content_sha256 IS NULL OR content_sha256 ~ '^[a-f0-9]{64}$'),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(meeting_id,requester_id,idempotency_key),
 UNIQUE(id,meeting_id,requester_id),
 CONSTRAINT export_ready_metadata CHECK(status <> 'READY' OR (expires_at IS NOT NULL AND storage_key IS NOT NULL AND content_type IS NOT NULL AND byte_size IS NOT NULL AND content_sha256 IS NOT NULL))
);
CREATE INDEX export_requests_creator_created_idx ON export_requests(requester_id,created_at);
CREATE INDEX export_requests_status_created_idx ON export_requests(status,created_at);
CREATE TABLE export_download_audit (
 id UUID PRIMARY KEY,
 export_id UUID NOT NULL,
 meeting_id UUID NOT NULL,
 requester_id UUID NOT NULL,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT export_download_audit_context_fkey FOREIGN KEY(export_id,meeting_id,requester_id) REFERENCES export_requests(id,meeting_id,requester_id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX export_download_audit_export_idx ON export_download_audit(export_id,created_at);
-- General exclusion is not purpose authorization: future adapters must separately
-- check active creator, membership, current purpose, state and clock in their transaction.
CREATE FUNCTION guard_export_request_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (OLD.status='READY' AND NEW.status NOT IN ('READY','EXPIRED'))
   OR (OLD.status='EXPIRED' AND NEW.status <> 'EXPIRED')
   OR (OLD.status='FAILED' AND NEW.status <> 'FAILED')
  THEN RAISE EXCEPTION 'Export settled state cannot reopen'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.meeting_id IS DISTINCT FROM OLD.meeting_id
   OR NEW.requester_id IS DISTINCT FROM OLD.requester_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
   OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.format IS DISTINCT FROM OLD.format OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN RAISE EXCEPTION 'Export request context is immutable'; END IF;
  IF OLD.status IN ('READY','EXPIRED') AND (
   NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
   OR NEW.content_type IS DISTINCT FROM OLD.content_type OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
   OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256)
  THEN RAISE EXCEPTION 'Export artifact identity is immutable'; END IF;
 END IF;
 PERFORM 1 FROM meetings WHERE id=NEW.meeting_id AND kind::text IN ('TECH','SALES') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Export meeting unavailable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER export_request_context_guard BEFORE INSERT OR UPDATE ON export_requests FOR EACH ROW EXECUTE FUNCTION guard_export_request_context();
CREATE FUNCTION preserve_export_download_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Export download audit is append only'; END;
$$;
CREATE TRIGGER export_download_audit_immutable BEFORE UPDATE OR DELETE ON export_download_audit FOR EACH ROW EXECUTE FUNCTION preserve_export_download_audit();
COMMIT;
