const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  NOTIFICATION_KINDS,
  NOTIFICATION_CHANNELS,
} = require('../../libs/meetings/src/domain/notification-create.policy.ts');
const {
  NOTIFICATION_DELIVERY_STATUSES,
  NotificationDeliveryPolicy,
} = require('../../libs/meetings/src/domain/notification-delivery.policy.ts');
const root = path.resolve(__dirname, '../..');
const migration = '20261103000000_notification_dispatch_foundation';
const schema = fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');
const sql = fs.readFileSync(
  path.join(root, 'prisma/migrations', migration, 'migration.sql'),
  'utf8',
);
const executable = sql.replace(/--[^\r\n]*/g, '');
function model(name) {
  const match = schema.match(
    new RegExp('model ' + name + ' \\{([\\s\\S]*?)\\n\\}'),
  );
  assert.ok(match, name);
  return match[1];
}
function table(name) {
  const match = sql.match(
    new RegExp('CREATE TABLE ' + name + ' \\(([\\s\\S]*?)\\n\\);'),
  );
  assert.ok(match, name);
  return match[1];
}
function values(constraint) {
  const match = sql.match(
    new RegExp(constraint + ' CHECK\\([^;]+? IN \\(([^)]+)\\)'),
  );
  assert.ok(match, constraint);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}
test('source migration is additive and does not weaken the existing event catalog', () => {
  assert.match(executable, /^\s*BEGIN;/);
  assert.match(executable, /COMMIT;\s*$/);
  assert.doesNotMatch(
    executable,
    /\b(?:DROP|DELETE|TRUNCATE|UPDATE|INSERT)\b(?!\s+(?:CASCADE|RESTRICT))/i,
  );
  assert.doesNotMatch(
    executable,
    /ALTER\s+COLUMN|outbox_events_creation_check/i,
  );
  assert.match(executable, /event_version=1/);
  assert.match(executable, /aggregate_type='Meeting'/);
});
test('receipt event identity supports retry fingerprints, with a separate optional UUID source reference', () => {
  const ddl = table('inbox_receipts'),
    entity = model('InboxReceipt');
  assert.match(ddl, /id TEXT NOT NULL/);
  assert.match(entity, /id String @id/);
  assert.match(ddl, /UNIQUE\(consumer,event_id\)/);
  assert.match(entity, /@@unique\(\[consumer,eventId\]/);
  assert.match(ddl, /event_id TEXT NOT NULL/);
  assert.doesNotMatch(entity, /eventId[^\n]+@db.Uuid/);
  assert.match(ddl, /source_outbox_event_id UUID,/);
  assert.match(
    ddl,
    /FOREIGN KEY\(source_outbox_event_id\) REFERENCES outbox_events\(id\) ON DELETE RESTRICT/,
  );
  const retryId = new NotificationDeliveryPolicy().composeRetryJobEventId(
    'synthetic-event',
    1,
  );
  assert.equal(typeof retryId, 'string');
  assert.ok(retryId.length > 0);
  assert.doesNotMatch(retryId, /^[a-f0-9]{8}-[a-f0-9-]{27}$/);
});
test('notification and delivery identities preserve deterministic non-UUID keys', () => {
  for (const [entity, physical] of [
    ['Notification', 'notifications'],
    ['NotificationDelivery', 'notification_deliveries'],
  ]) {
    assert.match(model(entity), /id String @id\s/);
    assert.match(table(physical), /id TEXT NOT NULL/);
  }
  assert.match(
    table('notification_deliveries'),
    /notification_id TEXT NOT NULL/,
  );
  assert.match(
    table('notification_deliveries'),
    /UNIQUE\(notification_id,channel,attempt\)/,
  );
  assert.match(
    model('NotificationDelivery'),
    /@@unique\(\[notificationId,channel,attempt\]/,
  );
});
test('SQL vocabularies exactly match the existing approved policy sets', () => {
  assert.deepEqual(values('notifications_kind_check'), [...NOTIFICATION_KINDS]);
  assert.deepEqual(values('notification_deliveries_channel_check'), [
    ...NOTIFICATION_CHANNELS,
  ]);
  assert.deepEqual(values('notification_deliveries_status_check'), [
    ...NOTIFICATION_DELIVERY_STATUSES,
  ]);
});
test('seen state consistency, positive channel ordinals and recipient lookup are explicit', () => {
  assert.match(sql, /state='UNREAD' AND seen_at IS NULL/);
  assert.match(sql, /state='READ' AND seen_at IS NOT NULL/);
  assert.match(sql, /CHECK\(attempt>=1\)/);
  assert.match(sql, /notifications\(recipient_user_id,seen_at,created_at,id\)/);
  assert.match(
    model('Notification'),
    /@@index\(\[recipientUserId,seenAt,createdAt,id\]/,
  );
});
test('new relationships restrict deletion and do not invent a polymorphic resource grant', () => {
  assert.match(
    sql,
    /FOREIGN KEY\(recipient_user_id\) REFERENCES users\(id\) ON DELETE RESTRICT/,
  );
  assert.match(
    sql,
    /FOREIGN KEY\(notification_id\) REFERENCES notifications\(id\) ON DELETE RESTRICT/,
  );
  assert.doesNotMatch(
    executable,
    /ON DELETE CASCADE|FOREIGN KEY\(resource_id\)/,
  );
  assert.match(
    model('Notification'),
    /resourceId String @map\("resource_id"\)/,
  );
});
test('outbox lease pairs, claim counter and due index have schema/SQL mappings', () => {
  for (const [camel, physical] of [
    ['aggregateType', 'aggregate_type'],
    ['eventVersion', 'event_version'],
    ['nextRetryAt', 'next_retry_at'],
    ['lockedBy', 'locked_by'],
    ['lockedUntil', 'locked_until'],
  ]) {
    assert.match(
      model('OutboxEvent'),
      new RegExp(camel + '[^\\n]+@map\\("' + physical + '"\\)'),
    );
    assert.match(sql, new RegExp('ADD COLUMN ' + physical + '\\b'));
  }
  assert.match(sql, /CHECK\(\(locked_by IS NULL\)=\(locked_until IS NULL\)\)/);
  assert.match(sql, /CHECK\(attempts>=0\)/);
  assert.match(
    sql,
    /outbox_events\(dispatched_at,next_retry_at,created_at,id\)/,
  );
});
test('new timestamps, retention and lease durations have no invented policy defaults', () => {
  for (const name of ['InboxReceipt', 'Notification', 'NotificationDelivery'])
    assert.doesNotMatch(
      model(name),
      /@default\(now\(\)\)|expiresAt|retention|purge/i,
    );
  assert.doesNotMatch(sql, /INTERVAL|\bTTL\b|CURRENT_TIMESTAMP|expires_at/i);
});
test('offline Prisma config never loads environment or supplies connection/generation hooks', () => {
  const config = fs
    .readFileSync(path.join(root, 'prisma.offline.config.ts'), 'utf8')
    .replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(
    config,
    /dotenv|datasource|DATABASE_URL|seed|migrations|generator/,
  );
  assert.match(config, /defineConfig\(\{ schema: 'prisma\/schema.prisma' \}\)/);
});
test('historical migration files remain pinned against the existing fixture manifest', () => {
  const fixture = fs.readFileSync(
    path.join(root, 'test/fixtures/auth-session-database.ts'),
    'utf8',
  );
  const historical = fixture
    .split('historicalMigrationDigests: Record<string, string> = {')[1]
    .split('\n};')[0];
  const pins = [...historical.matchAll(/'([^']+)':\s*'([a-f0-9]{64})'/g)];
  const directories = fs
    .readdirSync(path.join(root, 'prisma/migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  assert.ok(pins.length >= 17);
  assert.equal(pins.length, directories.length);
  for (const [, name, expected] of pins)
    assert.equal(
      crypto
        .createHash('sha256')
        .update(
          fs.readFileSync(
            path.join(root, 'prisma/migrations', name, 'migration.sql'),
          ),
        )
        .digest('hex'),
      expected,
      name,
    );
});
