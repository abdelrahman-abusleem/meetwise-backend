const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const schema = fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');
const migration = fs.readFileSync(
  path.join(
    root,
    'prisma/migrations/20261027000000_transcript_ingestion/migration.sql',
  ),
  'utf8',
);
const sql = migration.replace(/\r\n/g, '\n');
function model(name) {
  const found = schema.match(
    new RegExp('model ' + name + ' \\{([\\s\\S]*?)\\n\\}'),
  );
  assert.ok(found, name);
  return found[1];
}
test('saved transcript migration bytes retain the qualified protected fingerprint', () => {
  assert.equal(
    crypto.createHash('sha256').update(migration).digest('hex'),
    'c129d5723a847d3cafd7fc7cf9086e555f2b774d351ba53b288667694905518a',
  );
});
test('all seven specialized models coexist with newer notification and receipt sources', () => {
  for (const name of [
    'BotSession',
    'TranscriptInbox',
    'Transcript',
    'TranscriptSegment',
    'TranscriptRevisionSegment',
    'TranscriptInboxReceipt',
    'TranscriptProcessingAudit',
    'Notification',
    'NotificationDelivery',
    'InboxReceipt',
  ])
    assert.ok(model(name));
  assert.match(model('OutboxEvent'), /lockedBy String\?/);
  assert.match(model('Meeting'), /botSessions BotSession\[\]/);
  assert.match(model('Meeting'), /managerAccess MeetingAccess/);
  assert.match(model('InboxReceipt'), /eventId String @map\("event_id"\)\s/);
});
test('admitted event binds session and meeting through composite foreign keys', () => {
  assert.match(
    model('TranscriptInbox'),
    /fields:\[botSessionId,meetingId\],references:\[id,meetingId\]/,
  );
  assert.match(
    sql,
    /FOREIGN KEY\(bot_session_id,meeting_id\) REFERENCES bot_sessions\(id,meeting_id\) ON DELETE RESTRICT/,
  );
  assert.match(sql, /UNIQUE\(provider,provider_event_id\)/);
  assert.match(sql, /UNIQUE\(id,meeting_id,bot_session_id\)/);
});
test('segment event binding cannot cross admitted event/session/meeting context', () => {
  assert.match(
    model('TranscriptSegment'),
    /fields:\[eventId,meetingId,botSessionId\],references:\[id,meetingId,botSessionId\]/,
  );
  assert.match(
    sql,
    /FOREIGN KEY\(event_id,meeting_id,bot_session_id\) REFERENCES transcript_inbox\(id,meeting_id,bot_session_id\)/,
  );
  assert.match(sql, /UNIQUE\(bot_session_id,dedupe_hash\)/);
  assert.match(sql, /end_ms>=start_ms/);
});
test('sealed revision membership preserves addressed segment and ordinal identity', () => {
  assert.match(
    sql,
    /FOREIGN KEY\(transcript_id,meeting_id\) REFERENCES transcripts\(id,meeting_id\)/,
  );
  assert.match(
    sql,
    /FOREIGN KEY\(segment_id,meeting_id,ordinal\) REFERENCES transcript_segments\(id,meeting_id,ordinal\)/,
  );
  assert.match(
    sql,
    /PRIMARY KEY\(transcript_id,ordinal\), UNIQUE\(transcript_id,segment_id\)/,
  );
  for (const table of [
    'transcript_inbox',
    'transcript_segments',
    'transcript_revision_segments',
  ])
    assert.match(
      sql,
      new RegExp(
        'BEFORE UPDATE ON ' +
          table +
          ' FOR EACH ROW EXECUTE FUNCTION reject_transcript_evidence_update',
      ),
    );
});
test('content remains in encrypted events while segment storage contains hashes and references', () => {
  assert.match(
    model('TranscriptInbox'),
    /encryptedEvent Json @map\("encrypted_event"\)/,
  );
  assert.match(
    sql,
    /encrypted_event JSONB NOT NULL CHECK\(jsonb_typeof\(encrypted_event\)='object'\)/,
  );
  assert.doesNotMatch(
    model('TranscriptSegment'),
    /\n\s*(?:text|body|speaker|plaintext|token|keyMaterial)\s/,
  );
  assert.doesNotMatch(
    sql,
    /ON DELETE CASCADE|\bINTERVAL\b|retention|expires_at|REQUIRE_SYSTEM_APPROVAL/,
  );
});
test('extended outbox catalog preserves all four prior guarded payload branches', () => {
  const previous = fs
    .readFileSync(
      path.join(
        root,
        'prisma/migrations/20261026010000_cancellation_decisions/migration.sql',
      ),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
  const extract = (text) =>
    text
      .split('ADD CONSTRAINT outbox_events_creation_check CHECK ((\n')[1]
      .split('\n) IS TRUE);')[0];
  assert.ok(extract(sql).startsWith(extract(previous) + ' OR\n'));
  assert.match(sql, /type='transcript.revision_ready.v1'/);
  assert.match(
    sql,
    /payload=jsonb_build_object\('meetingId',aggregate_id::text,'transcriptId',payload->>'transcriptId','revision',aggregate_version\)/,
  );
});
test('receipt/audit identity and existing active-recipient schema remain isolated', () => {
  assert.match(sql, /consumer='transcript-ingest'/);
  assert.match(sql, /PRIMARY KEY\(consumer,event_id\)/);
  assert.match(
    sql,
    /created_at TIMESTAMPTZ\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE\(event_id\)/,
  );
  assert.match(
    model('Notification'),
    /recipientUserId String @map\("recipient_user_id"\) @db.Uuid/,
  );
  assert.doesNotMatch(
    sql,
    /^\s*(?:UPDATE\s+\w+|DELETE FROM|TRUNCATE|DROP TABLE|INSERT INTO)/m,
  );
});
