const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  p = require('node:path');
const root = p.resolve(__dirname, '../..'),
  schema = fs.readFileSync(p.join(root, 'prisma/schema.prisma'), 'utf8'),
  file = p.join(
    root,
    'prisma/migrations/20261104010000_analysis_item_evidence/migration.sql',
  ),
  sql = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const model = (name) =>
  schema.match(new RegExp('model ' + name + ' \\{([\\s\\S]*?)\\n\\}'))?.[1] ??
  '';
test('item is bound to exact run, meeting and pinned transcript identity', () => {
  assert.match(model('AnalysisItem'), /@@map\("analysis_items"\)/);
  assert.match(
    sql,
    /FOREIGN KEY\(run_id,meeting_id,transcript_id\) REFERENCES analysis_runs\(id,meeting_id,transcript_id\) ON DELETE RESTRICT ON UPDATE NO ACTION/,
  );
  assert.match(model('AnalysisRun'), /@@unique\(\[id,meetingId,transcriptId\]/);
  assert.match(
    model('AnalysisItem'),
    /references:\[id,meetingId,transcriptId\]/,
  );
});
test('evidence cannot cite a segment outside the item exact input revision', () => {
  assert.match(
    sql,
    /FOREIGN KEY\(item_id,meeting_id,transcript_id\) REFERENCES analysis_items\(id,meeting_id,transcript_id\)/,
  );
  assert.match(
    sql,
    /FOREIGN KEY\(transcript_id,segment_id\) REFERENCES transcript_revision_segments\(transcript_id,segment_id\)/,
  );
  assert.match(model('ItemEvidence'), /references:\[transcriptId,segmentId\]/);
});
test('stable identity and same protected quote reference dedupe without forbidding multiple quotes per segment', () => {
  assert.match(sql, /UNIQUE\(item_id,segment_id,quoted_text_encrypted_ref\)/);
  assert.doesNotMatch(sql, /UNIQUE\(item_id,segment_id\)/);
  assert.match(sql, /id UUID PRIMARY KEY/);
});
test('new items and evidence cannot default to approved or verified', () => {
  assert.match(sql, /status TEXT NOT NULL DEFAULT 'PENDING'/);
  assert.match(sql, /verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED'/);
  assert.match(sql, /schema_fields_validated BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(sql, /item_version >= 0/);
});
test('private item content and quote are protected references with no destination or identity inference', () => {
  for (const name of [
    'title_encrypted_ref',
    'body_encrypted_ref',
    'quoted_text_encrypted_ref',
  ])
    assert.match(sql, new RegExp(name + ' TEXT NOT NULL CHECK'));
  assert.doesNotMatch(
    sql,
    /title TEXT|body TEXT|quoted_text TEXT|destination|assignee|grant|retention|expires_at/i,
  );
});
test('source and evidence identity cannot be rebound while verification remains a distinct fact', () => {
  for (const field of [
    'id',
    'item_id',
    'meeting_id',
    'transcript_id',
    'segment_id',
    'quoted_text_encrypted_ref',
    'created_at',
  ])
    assert.match(
      sql,
      new RegExp('NEW\\.' + field + ' IS DISTINCT FROM OLD\\.' + field),
    );
  assert.match(sql, /BEFORE UPDATE ON item_evidence/);
  assert.match(sql, /BEFORE UPDATE ON analysis_items/);
  assert.match(sql, /analysis_items_run_status_idx/);
});
test('migration source is additive with restrictive relationships and no data/client operations', () => {
  assert.match(sql, /BEGIN;/);
  assert.match(sql, /COMMIT;/);
  assert.doesNotMatch(
    sql,
    /DROP |TRUNCATE |DELETE FROM|CASCADE|ALTER TABLE users|UPDATE users/,
  );
  assert.match(model('TranscriptRevisionSegment'), /evidence ItemEvidence\[\]/);
});
const {
  AnalysisReviewPolicy,
} = require('../../libs/meetings/src/domain/analysis-review.policy.ts');
const approval = {
  command: 'APPROVE_ITEM',
  itemStatus: 'PENDING',
  approverAuthorizedAtWriteTime: true,
  accessVerified: true,
  currentItemVersion: 0,
  expectedItemVersion: 0,
  schemaFieldsValidated: true,
  evidenceValid: true,
  duplicateDecision: 'COMPLETED',
  generateExecution: false,
  meetingKind: 'TECH',
};
test('actual policy denies unverified evidence despite otherwise eligible approval', () => {
  const result = new AnalysisReviewPolicy().evaluate({
    ...approval,
    evidenceValid: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'EVIDENCE_NOT_VALID');
});
test('administrative status cannot replace scoped approver authorization', () => {
  const result = new AnalysisReviewPolicy().evaluate({
    ...approval,
    approverAuthorizedAtWriteTime: false,
    systemRole: 'OWNER',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'APPROVER_NOT_AUTHORIZED');
});
test('explicitly authorized current validated approval remains governed by existing policy', () => {
  assert.equal(new AnalysisReviewPolicy().evaluate(approval).ok, true);
  assert.equal(
    new AnalysisReviewPolicy().evaluate({ ...approval, expectedItemVersion: 1 })
      .ok,
    false,
  );
});
