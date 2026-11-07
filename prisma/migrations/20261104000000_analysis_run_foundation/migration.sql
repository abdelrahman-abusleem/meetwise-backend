-- SOURCE ONLY. Not applied. No provider, authorization or retention policy is enabled.
BEGIN;
ALTER TABLE transcripts ADD CONSTRAINT transcripts_analysis_snapshot_key UNIQUE(id,meeting_id,revision,snapshot_hash);
CREATE TABLE analysis_runs (
 id UUID PRIMARY KEY,
 meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 transcript_id UUID NOT NULL,
 transcript_revision INTEGER NOT NULL CHECK(transcript_revision >= 1),
 transcript_snapshot_hash VARCHAR(64) NOT NULL CHECK(transcript_snapshot_hash ~ '^[a-f0-9]{64}$'),
 input_fingerprint VARCHAR(64) NOT NULL CHECK(input_fingerprint ~ '^[a-f0-9]{64}$'),
 template_version TEXT NOT NULL CHECK(length(btrim(template_version)) > 0),
 prompt_version TEXT NOT NULL CHECK(length(btrim(prompt_version)) > 0),
 schema_version TEXT NOT NULL CHECK(length(btrim(schema_version)) > 0),
 model_id TEXT NOT NULL CHECK(length(btrim(model_id)) > 0),
 analysis_language TEXT NOT NULL CHECK(length(btrim(analysis_language)) > 0),
 state TEXT NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','VALIDATED','NEEDS_REVIEW','FAILED')),
 repair_count INTEGER NOT NULL DEFAULT 0 CHECK(repair_count BETWEEN 0 AND 3),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
 attempt_id UUID,
 leased_until TIMESTAMPTZ(3),
 token_input BIGINT NOT NULL DEFAULT 0 CHECK(token_input >= 0),
 token_output BIGINT NOT NULL DEFAULT 0 CHECK(token_output >= 0),
 failure_reason_encrypted_ref TEXT CHECK(failure_reason_encrypted_ref IS NULL OR length(btrim(failure_reason_encrypted_ref)) > 0),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT analysis_runs_snapshot_fkey FOREIGN KEY(transcript_id,meeting_id,transcript_revision,transcript_snapshot_hash) REFERENCES transcripts(id,meeting_id,revision,snapshot_hash) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT analysis_runs_lease_pair CHECK((attempt_id IS NULL) = (leased_until IS NULL)),
 CONSTRAINT analysis_runs_running_lease CHECK(state <> 'RUNNING' OR attempt_id IS NOT NULL),
 CONSTRAINT analysis_runs_failed_reason CHECK(state <> 'FAILED' OR failure_reason_encrypted_ref IS NOT NULL)
);
CREATE INDEX analysis_runs_meeting_created_idx ON analysis_runs(meeting_id,created_at);
CREATE INDEX analysis_runs_state_lease_idx ON analysis_runs(state,leased_until);
CREATE TABLE analysis_run_audit (
 id UUID PRIMARY KEY,
 run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 command TEXT NOT NULL CHECK(command IN ('CLAIM_RUN','RECORD_REPAIR','SETTLE_VALIDATED','SETTLE_NEEDS_REVIEW','SETTLE_FAILED','REANALYZE')),
 from_state TEXT NOT NULL CHECK(from_state IN ('QUEUED','RUNNING','VALIDATED','NEEDS_REVIEW','FAILED')),
 to_state TEXT NOT NULL CHECK(to_state IN ('QUEUED','RUNNING','VALIDATED','NEEDS_REVIEW','FAILED')),
 version_before INTEGER NOT NULL CHECK(version_before >= 0),
 version_after INTEGER NOT NULL CHECK(version_after >= version_before),
 attempt_id UUID,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX analysis_run_audit_run_idx ON analysis_run_audit(run_id,created_at);
CREATE FUNCTION verify_analysis_input_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM transcripts WHERE id=NEW.transcript_id AND meeting_id=NEW.meeting_id
  AND revision=NEW.transcript_revision AND snapshot_hash=NEW.transcript_snapshot_hash
  AND state IN ('PARTIAL','COMPLETE') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Analysis input snapshot unavailable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER analysis_run_input_admission BEFORE INSERT ON analysis_runs FOR EACH ROW EXECUTE FUNCTION verify_analysis_input_snapshot();
CREATE FUNCTION preserve_analysis_input_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.meeting_id IS DISTINCT FROM OLD.meeting_id
  OR NEW.transcript_id IS DISTINCT FROM OLD.transcript_id OR NEW.transcript_revision IS DISTINCT FROM OLD.transcript_revision
  OR NEW.transcript_snapshot_hash IS DISTINCT FROM OLD.transcript_snapshot_hash OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint
  OR NEW.template_version IS DISTINCT FROM OLD.template_version OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version
  OR NEW.schema_version IS DISTINCT FROM OLD.schema_version OR NEW.model_id IS DISTINCT FROM OLD.model_id
  OR NEW.analysis_language IS DISTINCT FROM OLD.analysis_language OR NEW.created_at IS DISTINCT FROM OLD.created_at
 THEN RAISE EXCEPTION 'Analysis input snapshot is immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER analysis_run_input_immutable BEFORE UPDATE ON analysis_runs FOR EACH ROW EXECUTE FUNCTION preserve_analysis_input_snapshot();
CREATE FUNCTION preserve_analysis_run_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Analysis run audit is append only'; END;
$$;
CREATE TRIGGER analysis_run_audit_immutable BEFORE UPDATE OR DELETE ON analysis_run_audit FOR EACH ROW EXECUTE FUNCTION preserve_analysis_run_audit();
COMMIT;
