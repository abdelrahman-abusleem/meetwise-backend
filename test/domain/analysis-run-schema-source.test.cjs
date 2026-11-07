const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  p = require('node:path');
const root = p.resolve(__dirname, '../..'),
  schema = fs.readFileSync(p.join(root, 'prisma/schema.prisma'), 'utf8');
const file = p.join(
  root,
  'prisma/migrations/20261104000000_analysis_run_foundation/migration.sql',
);
const sql = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const model = (name) =>
  schema.match(new RegExp('model ' + name + ' \\{([\\s\\S]*?)\\n\\}'))?.[1] ??
  '';
test('analysis run maps to a dedicated relational store with restrictive exact snapshot FK', () => {
  assert.match(model('AnalysisRun'), /@@map\("analysis_runs"\)/);
  assert.match(
    sql,
    /FOREIGN KEY\(transcript_id,meeting_id,transcript_revision,transcript_snapshot_hash\) REFERENCES transcripts\(id,meeting_id,revision,snapshot_hash\) ON DELETE RESTRICT ON UPDATE NO ACTION/,
  );
  assert.match(
    model('AnalysisRun'),
    /references:\[id,meetingId,revision,snapshotHash\]/,
  );
});
test('immutable input identity covers source, template, prompt, schema, model, language and fingerprint', () => {
  for (const field of [
    'id',
    'meeting_id',
    'transcript_id',
    'transcript_revision',
    'transcript_snapshot_hash',
    'template_version',
    'prompt_version',
    'schema_version',
    'model_id',
    'analysis_language',
    'input_fingerprint',
    'created_at',
  ])
    assert.match(
      sql,
      new RegExp('NEW\\.' + field + ' IS DISTINCT FROM OLD\\.' + field),
    );
  assert.match(sql, /BEFORE UPDATE ON analysis_runs/);
});
test('new input admission checks sealed source state under a source lock without granting actor authority', () => {
  assert.match(sql, /state IN \('PARTIAL','COMPLETE'\) FOR SHARE/);
  assert.match(
    sql,
    /IF NOT FOUND THEN RAISE EXCEPTION 'Analysis input snapshot unavailable'/,
  );
  assert.match(sql, /BEFORE INSERT ON analysis_runs/);
  assert.doesNotMatch(sql, /can_read|can_approve|GRANT |OWNER|MANAGER/);
});
test('repair bounds and status vocabulary match actual approved domain policy', () => {
  const {
    AnalysisRunPolicy,
  } = require('../../libs/meetings/src/domain/analysis-run.policy.ts');
  for (const status of [
    'QUEUED',
    'RUNNING',
    'VALIDATED',
    'NEEDS_REVIEW',
    'FAILED',
  ])
    assert.ok(sql.includes("'" + status + "'"));
  assert.match(sql, /repair_count BETWEEN 0 AND 3/);
  const policy = new AnalysisRunPolicy();
  assert.equal(
    policy.evaluate({
      command: 'RECORD_REPAIR',
      currentState: 'RUNNING',
      repairCount: 3,
    }).ok,
    false,
  );
  assert.match(sql, /version >= 0/);
});
test('attempt ownership and lease are paired and mandatory for RUNNING without choosing duration', () => {
  assert.match(sql, /\(attempt_id IS NULL\) = \(leased_until IS NULL\)/);
  assert.match(sql, /state <> 'RUNNING' OR attempt_id IS NOT NULL/);
  assert.doesNotMatch(sql, /INTERVAL|make_interval|leased_until[^\n]*DEFAULT/);
  assert.match(sql, /analysis_runs_state_lease_idx/);
});
test('usage metadata is nonnegative and failure details use only protected references', () => {
  assert.match(sql, /token_input >= 0/);
  assert.match(sql, /token_output >= 0/);
  assert.match(sql, /failure_reason_encrypted_ref TEXT/);
  assert.match(
    sql,
    /state <> 'FAILED' OR failure_reason_encrypted_ref IS NOT NULL/,
  );
  assert.doesNotMatch(
    sql,
    /raw_output|transcript_text|quoted_text|failure_reason TEXT/,
  );
});
test('audit is append-only metadata with restrictive run FK and exact command vocabulary', () => {
  assert.match(sql, /REFERENCES analysis_runs\(id\) ON DELETE RESTRICT/);
  for (const command of [
    'CLAIM_RUN',
    'RECORD_REPAIR',
    'SETTLE_VALIDATED',
    'SETTLE_NEEDS_REVIEW',
    'SETTLE_FAILED',
    'REANALYZE',
  ])
    assert.ok(sql.includes("'" + command + "'"));
  assert.match(sql, /BEFORE UPDATE OR DELETE ON analysis_run_audit/);
  assert.match(sql, /version_after >= version_before/);
  assert.doesNotMatch(
    model('AnalysisRunAudit'),
    /body|payload|content|reason|text/,
  );
});
test('source migration is additive and preserves current catalog and historical state', () => {
  assert.match(sql, /BEGIN;/);
  assert.match(sql, /COMMIT;/);
  assert.doesNotMatch(
    sql,
    /DROP |TRUNCATE |DELETE FROM|UPDATE users|ALTER TABLE users|ALTER TABLE outbox_events/,
  );
  assert.match(model('Meeting'), /analysisRuns AnalysisRun\[\]/);
  assert.match(model('Transcript'), /analysisRuns AnalysisRun\[\]/);
});
