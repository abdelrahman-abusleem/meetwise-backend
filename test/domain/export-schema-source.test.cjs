const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  p = require('node:path');
const root = p.resolve(__dirname, '../..'),
  schema = fs.readFileSync(p.join(root, 'prisma/schema.prisma'), 'utf8'),
  file = p.join(
    root,
    'prisma/migrations/20261104020000_export_request_foundation/migration.sql',
  ),
  sql = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const model = (name) =>
  schema.match(new RegExp('model ' + name + ' \\{([\\s\\S]*?)\\n\\}'))?.[1] ??
  '';
test('export identity has explicit meeting and creator FKs with scoped idempotency', () => {
  assert.match(model('ExportRequest'), /@@map\("export_requests"\)/);
  assert.match(
    sql,
    /meeting_id UUID NOT NULL REFERENCES meetings\(id\) ON DELETE RESTRICT/,
  );
  assert.match(
    sql,
    /requester_id UUID NOT NULL REFERENCES users\(id\) ON DELETE RESTRICT/,
  );
  assert.match(sql, /UNIQUE\(meeting_id,requester_id,idempotency_key\)/);
  assert.match(sql, /idempotency_key VARCHAR\(128\)/);
});
test('enums match existing contract and QUEUED is the only default state', () => {
  for (const value of [
    'SUMMARY',
    'TRANSCRIPT',
    'ANALYSIS',
    'JSON',
    'CSV',
    'PDF',
    'QUEUED',
    'RUNNING',
    'READY',
    'FAILED',
    'EXPIRED',
  ])
    assert.ok(sql.includes("'" + value + "'"));
  assert.match(sql, /status TEXT NOT NULL DEFAULT 'QUEUED'/);
  assert.match(sql, /byte_size >= 0/);
});
test('READY requires stored expiry and complete private artifact metadata without a duration default', () => {
  assert.match(
    sql,
    /status <> 'READY' OR \(expires_at IS NOT NULL AND storage_key IS NOT NULL AND content_type IS NOT NULL AND byte_size IS NOT NULL AND content_sha256 IS NOT NULL\)/,
  );
  assert.match(sql, /expires_at TIMESTAMPTZ\(3\),/);
  assert.doesNotMatch(
    sql,
    /expires_at[^\n]*DEFAULT|INTERVAL|make_interval|retention|can_export|GRANT /i,
  );
});
test('audit must name the same export meeting and actual creator, with append-only metadata', () => {
  assert.match(
    sql,
    /FOREIGN KEY\(export_id,meeting_id,requester_id\) REFERENCES export_requests\(id,meeting_id,requester_id\)/,
  );
  assert.match(
    model('ExportDownloadAudit'),
    /references:\[id,meetingId,requesterId\]/,
  );
  assert.match(sql, /BEFORE UPDATE OR DELETE ON export_download_audit/);
  assert.doesNotMatch(
    model('ExportDownloadAudit'),
    /^\s*(?:content\w*|body\w*|token\w*|url\w*|key\w*)\s+/im,
  );
});
test('GENERAL and unknown meeting kinds are refused at storage admission under a source lock', () => {
  assert.match(sql, /kind::text IN \('TECH','SALES'\) FOR SHARE/);
  assert.match(
    sql,
    /IF NOT FOUND THEN RAISE EXCEPTION 'Export meeting unavailable'/,
  );
  assert.match(sql, /BEFORE INSERT OR UPDATE ON export_requests/);
});
test('request payload and settled artifact identities cannot be silently rebound', () => {
  for (const field of [
    'id',
    'meeting_id',
    'requester_id',
    'idempotency_key',
    'kind',
    'format',
    'created_at',
  ])
    assert.match(
      sql,
      new RegExp('NEW\\.' + field + ' IS DISTINCT FROM OLD\\.' + field),
    );
  for (const field of [
    'expires_at',
    'storage_key',
    'content_type',
    'byte_size',
    'content_sha256',
  ])
    assert.match(
      sql,
      new RegExp('NEW\\.' + field + ' IS DISTINCT FROM OLD\\.' + field),
    );
  assert.match(sql, /OLD.status IN \('READY','EXPIRED'\)/);
});
test('settled state cannot reopen to bypass artifact identity and expiry immutability', () => {
  assert.match(
    sql,
    /OLD.status='READY' AND NEW.status NOT IN \('READY','EXPIRED'\)/,
  );
  assert.match(sql, /OLD.status='EXPIRED' AND NEW.status <> 'EXPIRED'/);
  assert.match(sql, /RAISE EXCEPTION 'Export settled state cannot reopen'/);
});
test('FAILED requests cannot reopen under an old idempotency identity', () => {
  assert.match(sql, /OLD.status='FAILED' AND NEW.status <> 'FAILED'/);
});
test('source is additive, no content blob, token issuer, source-selection invention or outbox catalog replacement', () => {
  assert.match(sql, /BEGIN;/);
  assert.match(sql, /COMMIT;/);
  assert.doesNotMatch(
    sql,
    /DROP |TRUNCATE |DELETE FROM|CASCADE|ALTER TABLE outbox_events|file_content|delivery_token/,
  );
  assert.match(model('User'), /exports ExportRequest\[\]/);
  assert.match(model('Meeting'), /exports ExportRequest\[\]/);
});
const {
  ExportRequestPolicy,
} = require('../../libs/meetings/src/domain/export-request.policy.ts');
test('actual API and worker policy refuse GENERAL regardless of role or other facts', () => {
  const policy = new ExportRequestPolicy();
  for (const [command, surface] of [
    ['REQUEST_EXPORT', 'API'],
    ['WORKER_EXPORT_GATE', 'WORKER'],
  ])
    assert.equal(
      policy.evaluate({
        command,
        surface,
        kind: 'TRANSCRIPT',
        meetingKind: 'GENERAL',
        exporterAuthorized: true,
        idempotencyKeyProvided: true,
      }).reason,
      'GENERAL_EXPORT_REJECTED',
    );
});
test('creator metadata and OWNER role cannot replace explicit current download permission', () => {
  const decision = new ExportRequestPolicy().evaluate({
    command: 'DOWNLOAD_EXPORT',
    surface: 'DOWNLOAD',
    kind: 'TRANSCRIPT',
    meetingKind: 'TECH',
    exporterAuthorized: false,
    requesterIsCreator: true,
    systemRole: 'OWNER',
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'DOWNLOAD_NOT_AUTHORIZED');
});
test('actual analysis gate refuses current REJECTED items', () => {
  const decision = new ExportRequestPolicy().evaluate({
    command: 'WORKER_EXPORT_GATE',
    surface: 'WORKER',
    kind: 'ANALYSIS',
    meetingKind: 'TECH',
    exporterAuthorized: true,
    idempotencyKeyProvided: true,
    sourceItems: [{ id: 'synthetic', status: 'REJECTED' }],
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'REJECTED_ITEM_NOT_EXPORTABLE');
});
