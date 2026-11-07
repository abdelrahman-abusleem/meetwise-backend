-- SOURCE ONLY: not applied, no provider or approval flow is enabled.
BEGIN;
ALTER TABLE analysis_runs ADD CONSTRAINT analysis_runs_item_context_key UNIQUE(id,meeting_id,transcript_id);
CREATE TABLE analysis_items (
 id UUID PRIMARY KEY,
 run_id UUID NOT NULL,
 meeting_id UUID NOT NULL,
 transcript_id UUID NOT NULL,
 kind TEXT NOT NULL CHECK(length(btrim(kind)) > 0),
 title_encrypted_ref TEXT NOT NULL CHECK(length(btrim(title_encrypted_ref)) > 0),
 body_encrypted_ref TEXT NOT NULL CHECK(length(btrim(body_encrypted_ref)) > 0),
 item_version INTEGER NOT NULL DEFAULT 0 CHECK(item_version >= 0),
 schema_fields_validated BOOLEAN NOT NULL DEFAULT FALSE,
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','NEEDS_EDITS','REJECTED','APPROVED')),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(id,meeting_id,transcript_id),
 CONSTRAINT analysis_items_run_context_fkey FOREIGN KEY(run_id,meeting_id,transcript_id) REFERENCES analysis_runs(id,meeting_id,transcript_id) ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX analysis_items_run_status_idx ON analysis_items(run_id,status);
CREATE TABLE item_evidence (
 id UUID PRIMARY KEY,
 item_id UUID NOT NULL,
 meeting_id UUID NOT NULL,
 transcript_id UUID NOT NULL,
 segment_id UUID NOT NULL,
 quoted_text_encrypted_ref TEXT NOT NULL CHECK(length(btrim(quoted_text_encrypted_ref)) > 0),
 verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK(verification_status IN ('UNVERIFIED','VERIFIED')),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT item_evidence_item_context_fkey FOREIGN KEY(item_id,meeting_id,transcript_id) REFERENCES analysis_items(id,meeting_id,transcript_id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT item_evidence_revision_segment_fkey FOREIGN KEY(transcript_id,segment_id) REFERENCES transcript_revision_segments(transcript_id,segment_id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 UNIQUE(item_id,segment_id,quoted_text_encrypted_ref)
);
CREATE INDEX item_evidence_item_status_idx ON item_evidence(item_id,verification_status);
-- These identity guards do not authorize content changes or approval. Future
-- repositories must enforce actor, version, validation and immutable approval snapshots.
CREATE FUNCTION preserve_analysis_item_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.run_id IS DISTINCT FROM OLD.run_id
  OR NEW.meeting_id IS DISTINCT FROM OLD.meeting_id OR NEW.transcript_id IS DISTINCT FROM OLD.transcript_id
  OR NEW.created_at IS DISTINCT FROM OLD.created_at
 THEN RAISE EXCEPTION 'Analysis item context is immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER analysis_item_context_immutable BEFORE UPDATE ON analysis_items FOR EACH ROW EXECUTE FUNCTION preserve_analysis_item_context();
CREATE FUNCTION preserve_item_evidence_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.item_id IS DISTINCT FROM OLD.item_id
  OR NEW.meeting_id IS DISTINCT FROM OLD.meeting_id OR NEW.transcript_id IS DISTINCT FROM OLD.transcript_id
  OR NEW.segment_id IS DISTINCT FROM OLD.segment_id OR NEW.quoted_text_encrypted_ref IS DISTINCT FROM OLD.quoted_text_encrypted_ref
  OR NEW.created_at IS DISTINCT FROM OLD.created_at
 THEN RAISE EXCEPTION 'Item evidence identity is immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER item_evidence_identity_immutable BEFORE UPDATE ON item_evidence FOR EACH ROW EXECUTE FUNCTION preserve_item_evidence_identity();
COMMIT;
