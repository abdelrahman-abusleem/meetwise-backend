import { migrate as migrateProcess } from './migration-process.cjs';
import { SESSION_SETUP_TIMEOUT_MS } from '../e2e-budgets.cjs';
export { SESSION_SETUP_TIMEOUT_MS };
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

const root = path.resolve(__dirname, '../..');
const baselineMigrations = [
  '20260712233709_create_system_settings',
  '20261006000000_complete_auth_license_foundation',
];

const historicalMigrationDigests: Record<string, string> = {
  '20261104020000_export_request_foundation':
    'c91f6c0e6521ddff80115e68a11822fe12ce5f70027f3a51896b7683405d991f',
  '20261104010000_analysis_item_evidence':
    '578c91baf027723e25604ed97161a7646fa79b43847846fa3d9537aaca38ef98',
  '20261104000000_analysis_run_foundation':
    '478fee1fd90c7b1e1b64ada0bf98028e51c21c1ea8619ded2165ffa5800c8142',
  '20261027000000_transcript_ingestion':
    'c129d5723a847d3cafd7fc7cf9086e555f2b774d351ba53b288667694905518a',
  '20261103000000_notification_dispatch_foundation':
    'd1dff5b877c7ad3e8e61f4c840cd76fb16a72196681211c3e7d0ba2079692812',
  '20261026010000_cancellation_decisions':
    'f27a1a605a4ad36e58aea3bc0f0a34d97d38a9d3ac6ebd1d735423431f6f85d0',
  '20261026000000_cancellation_requests':
    'c6198a517a9e2f790b51de119bc9a69be59a0c899782d139c9a260b07a689ffd',
  '20261025000000_meeting_draft_creation':
    'd89633b23dea8521476ca6bf6da6e71f54d0e775246b14c29f190ffcba0dd097',
  '20261023050000_add_wizard_activation':
    '994e93ab5fabedc2a98fd1d54605095432ab3b792622fc07e65c802c0a5c1ff9',
  '20261023040000_add_wizard_drafts':
    '63cff9a03838ec78b0329f84ed71c699498b7d88f579b2aaa767e7beeefd5247',
  '20261023030000_add_department_memberships':
    '3793434e694304e65deabeac699b6dfd43af403b788c6dd0791ac1d541327b07',
  '20261023020000_add_pending_account_activation':
    '80d5ca57f1742dfa331da1d4b0557cfd07e1df8959d77323c19dae6b2f1a1a88',
  '20261023010000_add_administrative_reset':
    'a49487501fb4648ec9cb72577cc06d47bafbd372c3490c4cc7b0e81f0468a035',
  '20260712233709_create_system_settings':
    '40b56c046a68294173cfa027fdb09b746606c20f4e47077f133e7640c4e681d0',
  '20261006000000_complete_auth_license_foundation':
    'd77f8b70a1c080ccc635227c258282543ed1f283f3ce76017de8f3a12ff0b2e2',
  '20261022000000_add_auth_session_families':
    '71bbf8542ce40a0485e98398d9a0d493b022b0d3bf642522b008d11857e46c4c',
  '20261022010000_add_bootstrap_token':
    'dca2953720a9c66ae049f83c12313ff73ac817414a872799259bb52e21eef3ad',
  '20261022020000_canonical_system_roles':
    '16faf810bdc593a3de70f1f6d31d3d5f4b90b2809e87dff21eb8955a1794ff40',
  '20261022030000_add_bot_display_audit':
    'c66751fbc7185b8af528af4160db588fafa90ee64216277b9760812fbec3b95a',
  '20261022040000_add_department_module_foundation':
    '6f99d9e922eb83b4b645d4454dc34edff556af60ad85d5cd56e42b26528e1457',
  '20261023000000_add_owner_recovery':
    'cdf386d706f09a5fc77be80e8ae794c0a3d3396318f071d2d411e14779818c9f',
};

function verifyHistoricalMigrationDigests(): void {
  for (const [name, expected] of Object.entries(historicalMigrationDigests)) {
    const actual = createHash('sha256')
      .update(
        readFileSync(
          path.join(root, 'prisma/migrations', name, 'migration.sql'),
        ),
      )
      .digest('hex');
    if (actual !== expected) {
      throw new Error(
        'Historical migration byte integrity failed for ' +
          name +
          '; historical migrations must never be edited (sha256 mismatch)',
      );
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid disposable fixture metadata');
  }
  return value as Record<string, unknown>;
}

function oneJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error('Expected exactly one disposable fixture');
  }
  return record(value[0]);
}

function docker(args: string[], input?: Buffer): Buffer {
  const result = spawnSync('docker', args, {
    input,
    encoding: null,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error('Disposable database operation failed');
  return result.stdout;
}

async function identifyDisposablePostgres(): Promise<{
  containerId: string;
  url: URL;
}> {
  const runId = process.env.MEETWISE_E2E_RUN_ID;
  const name = process.env.MEETWISE_E2E_PG_CONTAINER;
  const port = process.env.MEETWISE_E2E_PG_PORT;
  if (
    !runId ||
    !/^mw-e2e-[a-f0-9-]{36}$/.test(runId) ||
    name !== runId + '-postgres'
  ) {
    throw new Error('Owned disposable PostgreSQL metadata is required');
  }
  const context = oneJsonObject(docker(['context', 'inspect']).toString());
  const endpoint = record(record(context.Endpoints).docker).Host;
  const hostOverride = process.env.DOCKER_HOST;
  if (
    typeof endpoint !== 'string' ||
    !/^(npipe:|unix:)/.test(endpoint) ||
    (hostOverride && !/^(npipe:|unix:)/.test(hostOverride))
  ) {
    throw new Error('A local Docker transport is required');
  }
  const container = oneJsonObject(docker(['inspect', name]).toString());
  const labels = record(record(container.Config).Labels);
  const ports = record(record(container.NetworkSettings).Ports);
  const bindings: unknown = ports['5432/tcp'];
  if (!Array.isArray(bindings) || bindings.length !== 1) {
    throw new Error('Unexpected PostgreSQL binding');
  }
  const binding = record(bindings[0]);
  const containerId = container.Id;
  if (
    labels['meetwise.e2e-test'] !== runId ||
    container.Name !== '/' + name ||
    typeof containerId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(containerId) ||
    binding.HostIp !== '127.0.0.1' ||
    binding.HostPort !== port
  ) {
    throw new Error('Disposable PostgreSQL identity mismatch');
  }
  const url = new URL(process.env.DATABASE_URL || '');
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== port ||
    url.pathname !== '/meetwise_e2e' ||
    url.username !== 'postgres' ||
    url.password
  ) {
    throw new Error('Unexpected migration datasource');
  }
  const expectedId = docker([
    'exec',
    containerId,
    'psql',
    '-U',
    'postgres',
    '-d',
    'meetwise_e2e',
    '-tAc',
    'SELECT system_identifier::text FROM pg_control_system()',
  ])
    .toString()
    .trim();
  const pool = new Pool({
    connectionString: url.toString(),
    connectionTimeoutMillis: 1000,
    query_timeout: 5000,
  });
  try {
    const actual = await pool.query<{ system_id: string; database: string }>(
      'SELECT system_identifier::text AS system_id, current_database() AS database FROM pg_control_system()',
    );
    if (
      actual.rows[0]?.system_id !== expectedId ||
      actual.rows[0]?.database !== 'meetwise_e2e'
    ) {
      throw new Error('Connected PostgreSQL is not the owned container');
    }
  } finally {
    await pool.end();
  }
  return { containerId, url };
}

function migrate(url: URL, logPath: string, config?: string): Promise<void> {
  return migrateProcess(root, url, logPath, config);
}

async function snapshot(pool: Pool): Promise<unknown> {
  const result = await pool.query<{ snapshot: unknown }>(
    "SELECT jsonb_build_object('users', (SELECT jsonb_agg(to_jsonb(u) - 'must_change_password' ORDER BY id) FROM users u), " +
      "'licenses', (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM licenses l), " +
      "'settings', (SELECT jsonb_agg(to_jsonb(s) - 'bootstrap_token_hash' - 'bootstrap_expires_at' - 'bootstrap_consumed_at' - 'bot_display_version' - 'wizard_completed_at' - 'wizard_choice' ORDER BY id) FROM system_settings s)) AS snapshot",
  );
  return result.rows[0].snapshot;
}

export async function prepareSessionDatabase(): Promise<void> {
  const { containerId, url } = await identifyDisposablePostgres();
  let historicalMigrationsUnchanged = false;
  const suffix = randomUUID().replaceAll('-', '');
  const legacyName = 'mw_auth_legacy_' + suffix;
  const restoredName = 'mw_auth_restore_' + suffix;
  const ownedDatabases = new Set<string>();
  const folder = path.join(root, '.tmp', 'auth-family-' + suffix);
  const stagedMigrations = path.join(folder, 'baseline-migrations');
  mkdirSync(stagedMigrations, { recursive: true });
  copyFileSync(
    path.join(root, 'prisma/migrations/migration_lock.toml'),
    path.join(stagedMigrations, 'migration_lock.toml'),
  );
  for (const name of baselineMigrations) {
    const dest = path.join(stagedMigrations, name);
    mkdirSync(dest);
    copyFileSync(
      path.join(root, 'prisma/migrations', name, 'migration.sql'),
      path.join(dest, 'migration.sql'),
    );
  }
  const config = path.join(folder, 'baseline.config.ts');
  writeFileSync(
    config,
    "import { defineConfig, env } from 'prisma/config';\nexport default defineConfig({" +
      'schema:' +
      JSON.stringify(path.join(root, 'prisma/schema.prisma')) +
      ',migrations:{path:' +
      JSON.stringify(stagedMigrations) +
      "},datasource:{url:env('DATABASE_URL')}});\n",
  );
  const databaseUrl = (database: string) => {
    const value = new URL(url);
    value.pathname = '/' + database;
    return value;
  };
  const failures: unknown[] = [];
  try {
    verifyHistoricalMigrationDigests();
    historicalMigrationsUnchanged = true;
    for (const name of [legacyName, restoredName]) {
      docker(['exec', containerId, 'createdb', '-U', 'postgres', name]);
      ownedDatabases.add(name);
    }
    const legacyUrl = databaseUrl(legacyName);
    await migrate(legacyUrl, path.join(folder, 'baseline-migrate.log'), config);
    const legacy = new Pool({
      connectionString: legacyUrl.toString(),
      connectionTimeoutMillis: 1000,
      query_timeout: 5000,
    });
    try {
      const userId = randomUUID();
      await legacy.query(
        "INSERT INTO users (id,email,name,role,password_hash,token_version,updated_at) VALUES ($1,$2,$3,'OWNER',$4,42,CURRENT_TIMESTAMP)",
        [
          userId,
          'legacy@example.invalid',
          'Synthetic legacy OWNER',
          'synthetic-unusable-password-hash',
        ],
      );
      await legacy.query(
        "INSERT INTO licenses (id,singleton_key,customer_name,installation_id,edition,updated_at) VALUES ($1,'system',$2,$3,'TRIAL',CURRENT_TIMESTAMP)",
        [randomUUID(), 'Synthetic legacy customer', randomUUID()],
      );
      await legacy.query(
        "INSERT INTO system_settings (id,company_name,installation_id,setup_completed,updated_at) VALUES ($1,'Synthetic initialized company',$2,true,CURRENT_TIMESTAMP)",
        [randomUUID(), randomUUID()],
      );
      await legacy.query(
        "INSERT INTO users (id,email,name,role,password_hash,token_version,updated_at) VALUES ($1,$2,'Synthetic MEMBER','MEMBER',$3,7,CURRENT_TIMESTAMP)",
        [
          randomUUID(),
          'member@example.invalid',
          'synthetic-member-password-hash',
        ],
      );
      const before = await snapshot(legacy);
      const backup = docker([
        'exec',
        containerId,
        'pg_dump',
        '-U',
        'postgres',
        '-Fc',
        '--no-owner',
        '--no-privileges',
        '-d',
        legacyName,
      ]);
      if (!backup.length) throw new Error('Empty synthetic backup');
      docker(
        [
          'exec',
          '-i',
          containerId,
          'pg_restore',
          '-U',
          'postgres',
          '--exit-on-error',
          '--no-owner',
          '--no-privileges',
          '-d',
          restoredName,
        ],
        backup,
      );
      const restored = new Pool({
        connectionString: databaseUrl(restoredName).toString(),
        connectionTimeoutMillis: 1000,
        query_timeout: 5000,
      });
      try {
        assert.deepEqual(await snapshot(restored), before);
        await restored.query(
          "INSERT INTO users (id,email,name,role,password_hash,updated_at) VALUES ($1,$2,'Unexpected ADMIN','ADMIN',$3,CURRENT_TIMESTAMP)",
          [
            randomUUID(),
            'unexpected-admin@example.invalid',
            'synthetic-unusable-hash',
          ],
        );
        const beforeRejectedUpgrade = await snapshot(restored);
        try {
          await assert.rejects(
            restored.query(
              readFileSync(
                path.join(
                  root,
                  'prisma/migrations/20261022020000_canonical_system_roles/migration.sql',
                ),
                'utf8',
              ),
            ),
            {
              code: 'P0001',
              message:
                'Legacy ADMIN records require an explicit OWNER-approved upgrade plan; no automatic conversion',
            },
          );
        } finally {
          await restored.query('ROLLBACK');
        }
        assert.deepEqual(await snapshot(restored), beforeRejectedUpgrade);
        const types = await restored.query<{
          old_type: string | null;
          new_type: string | null;
        }>(
          'SELECT to_regtype($type$"UserRole"$type$)::text AS old_type, to_regtype($type$"SystemRole"$type$)::text AS new_type',
        );
        assert.equal(types.rows[0].old_type, '"UserRole"');
        assert.equal(types.rows[0].new_type, null);
      } finally {
        await restored.end();
      }
      await migrate(legacyUrl, path.join(folder, 'upgrade-migrate.log'));
      assert.deepEqual(await snapshot(legacy), before);
      const wizard = await legacy.query(
        'SELECT wizard_completed_at, wizard_choice FROM system_settings',
      );
      assert.deepEqual(wizard.rows, [
        { wizard_completed_at: null, wizard_choice: null },
      ]);
      const pending = await legacy.query<{ pending: string }>(
        'SELECT count(*)::text AS pending FROM users WHERE must_change_password',
      );
      assert.equal(pending.rows[0].pending, '0');
      const admin = await legacy.query<{ role: string; token_version: number }>(
        'SELECT role, token_version FROM users WHERE id=$1',
        [userId],
      );
      assert.deepEqual(admin.rows[0], { role: 'OWNER', token_version: 42 });
      const table = await legacy.query<{ name: string | null }>(
        "SELECT to_regclass('public.auth_sessions')::text AS name",
      );
      assert.equal(table.rows[0].name, 'auth_sessions');
      const bootstrap = await legacy.query(
        'SELECT setup_completed, bootstrap_token_hash, bootstrap_expires_at, bootstrap_consumed_at FROM system_settings',
      );
      assert.deepEqual(bootstrap.rows, [
        {
          setup_completed: true,
          bootstrap_token_hash: null,
          bootstrap_expires_at: null,
          bootstrap_consumed_at: null,
        },
      ]);
      const departments = await legacy.query<{
        name: string | null;
        rows: string;
      }>(
        "SELECT to_regclass('public.departments')::text AS name, (SELECT count(*)::text FROM departments) AS rows",
      );
      assert.equal(departments.rows[0].name, 'departments');
      assert.equal(departments.rows[0].rows, '0');
    } finally {
      await legacy.end();
    }
    await migrate(url, path.join(folder, 'fresh-migrate.log'));
    writeFileSync(
      path.join(folder, 'migration-evidence.json'),
      JSON.stringify(
        {
          localContainerVerified: true,
          matchingSystemIdentifier: true,
          emptyDeployExit: 0,
          nonemptyUpgradeExit: 0,
          backupRestoreExit: 0,
          usersCredentialsOwnerMemberAndLicensePreserved: true,
          unexpectedAdminRejectedBeforeRoleWrites: true,
          historicalMigrationsUnchanged,
          historicalMigrationFilesChecked: Object.keys(
            historicalMigrationDigests,
          ).length,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    failures.push(error);
  }

  for (const name of ownedDatabases) {
    try {
      if (!/^mw_auth_(legacy|restore)_[a-f0-9]{32}$/.test(name))
        throw new Error('Refusing unknown cleanup target');
      docker([
        'exec',
        containerId,
        'dropdb',
        '--if-exists',
        '--force',
        '-U',
        'postgres',
        name,
      ]);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, 'Session database rehearsal failed');
  }
}

export async function rehearseCancellationUpgrade(
  targetMigration = '20261026000000_cancellation_requests',
): Promise<void> {
  assert(
    [
      '20261026000000_cancellation_requests',
      '20261026010000_cancellation_decisions',
    ].includes(targetMigration),
  );
  const withPendingRequest =
    targetMigration === '20261026010000_cancellation_decisions';
  const { containerId, url } = await identifyDisposablePostgres();
  verifyHistoricalMigrationDigests();
  const suffix = randomUUID().replaceAll('-', ''),
    names = ['mw_cancel_upgrade_' + suffix, 'mw_cancel_restore_' + suffix];
  const owned = new Set<string>(),
    failures: unknown[] = [];
  const folder = path.join(root, '.tmp', 'cancel-upgrade-' + suffix),
    staged = path.join(folder, 'migrations');
  mkdirSync(staged, { recursive: true });
  copyFileSync(
    path.join(root, 'prisma/migrations/migration_lock.toml'),
    path.join(staged, 'migration_lock.toml'),
  );
  for (const name of readdirSync(path.join(root, 'prisma/migrations')).filter(
    (name) => /^\d{14}_/.test(name) && name < targetMigration,
  )) {
    mkdirSync(path.join(staged, name));
    copyFileSync(
      path.join(root, 'prisma/migrations', name, 'migration.sql'),
      path.join(staged, name, 'migration.sql'),
    );
  }
  const config = path.join(folder, 'prior.config.ts');
  writeFileSync(
    config,
    "import {defineConfig,env} from 'prisma/config';export default defineConfig({schema:" +
      JSON.stringify(path.join(root, 'prisma/schema.prisma')) +
      ',migrations:{path:' +
      JSON.stringify(staged) +
      "},datasource:{url:env('DATABASE_URL')}});\n",
  );
  const databaseUrl = (name: string) => {
    assert(names.includes(name));
    const target = new URL(url);
    target.pathname = '/' + name;
    return target;
  };
  let snapshotSql =
    "SELECT jsonb_build_object('users',(SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u),'meetings',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM meetings m),'access',(SELECT jsonb_agg(to_jsonb(a) ORDER BY meeting_id,user_id) FROM meeting_access a),'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM meeting_creation_audit a),'outbox',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM outbox_events o)) AS data";
  if (withPendingRequest)
    snapshotSql =
      snapshotSql.slice(0, -') AS data'.length) +
      ",'requests',(SELECT jsonb_agg(to_jsonb(r) - 'decided_by_id' - 'decision_at' - 'decision_reason' ORDER BY id) FROM cancellation_requests r),'submissions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY actor_id,key_hash) FROM cancellation_submissions s),'requestAudit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM cancellation_request_audit a)) AS data";
  try {
    for (const name of names) {
      docker(['exec', containerId, 'createdb', '-U', 'postgres', name]);
      owned.add(name);
    }
    await migrate(
      databaseUrl(names[0]),
      path.join(folder, 'prior-migrate.log'),
      config,
    );
    const pool = new Pool({
      connectionString: databaseUrl(names[0]).toString(),
      connectionTimeoutMillis: 1000,
      query_timeout: 5000,
    });
    try {
      const actor = randomUUID(),
        meeting = randomUUID();
      const seed = await pool.connect();
      await seed.query('BEGIN');
      try {
        await seed.query(
          "INSERT INTO users(id,email,name,role,password_hash,updated_at) VALUES($1,'cancel-upgrade@example.invalid','Synthetic upgrade OWNER','OWNER','unusable-synthetic-hash',CURRENT_TIMESTAMP)",
          [actor],
        );
        await seed.query(
          "INSERT INTO meetings(id,kind,visibility,title,created_by_id,meeting_admin_id) VALUES($1,'GENERAL','COMPANY','Synthetic preserved meeting',$2,$2)",
          [meeting, actor],
        );
        await seed.query(
          "INSERT INTO meeting_access(meeting_id,user_id,role) VALUES($1,$2,'MEETING_ADMIN')",
          [meeting, actor],
        );
        await seed.query(
          'INSERT INTO meeting_creation_audit(id,meeting_id,actor_id) VALUES($1,$2,$3)',
          [randomUUID(), meeting, actor],
        );
        await seed.query(
          "INSERT INTO outbox_events(id,type,aggregate_id,aggregate_version,payload) VALUES($1,'meeting.created.v1',$2::uuid,0,jsonb_build_object('meetingId',$2::uuid::text))",
          [randomUUID(), meeting],
        );
        if (withPendingRequest) {
          const requestId = randomUUID();
          await seed.query(
            "INSERT INTO cancellation_requests(id,meeting_id,requested_by_id,reason) VALUES($1,$2,$3,'Synthetic preserved request')",
            [requestId, meeting, actor],
          );
          await seed.query(
            'INSERT INTO cancellation_request_audit(id,request_id,actor_id) VALUES($1,$2,$3)',
            [randomUUID(), requestId, actor],
          );
          const response = {
            id: requestId,
            meetingId: meeting,
            requestedById: actor,
            status: 'REQUESTED',
            version: 0,
          };
          await seed.query(
            'INSERT INTO cancellation_submissions(actor_id,key_hash,payload_hash,request_id,response) VALUES($1,$2,$3,$4,$5::jsonb)',
            [
              actor,
              'a'.repeat(64),
              'b'.repeat(64),
              requestId,
              JSON.stringify(response),
            ],
          );
          await seed.query(
            "INSERT INTO outbox_events(id,type,aggregate_id,aggregate_version,payload) VALUES($1,'cancellation.requested.v1',$2::uuid,0,jsonb_build_object('meetingId',$2::uuid::text,'requestId',$3::uuid::text))",
            [randomUUID(), meeting, requestId],
          );
        }
        await seed.query('COMMIT');
      } catch (error) {
        await seed.query('ROLLBACK');
        throw error;
      } finally {
        seed.release();
      }
      const before: unknown = (await pool.query<{ data: unknown }>(snapshotSql))
        .rows[0].data;
      const backup = docker([
        'exec',
        containerId,
        'pg_dump',
        '-U',
        'postgres',
        '-Fc',
        '--no-owner',
        '--no-privileges',
        '-d',
        names[0],
      ]);
      assert(backup.length > 0);
      docker(
        [
          'exec',
          '-i',
          containerId,
          'pg_restore',
          '-U',
          'postgres',
          '--exit-on-error',
          '--no-owner',
          '--no-privileges',
          '-d',
          names[1],
        ],
        backup,
      );
      const restored = new Pool({
        connectionString: databaseUrl(names[1]).toString(),
        connectionTimeoutMillis: 1000,
        query_timeout: 5000,
      });
      try {
        assert.deepEqual(
          (await restored.query<{ data: unknown }>(snapshotSql)).rows[0].data,
          before,
        );
      } finally {
        await restored.end();
      }
      await migrate(
        databaseUrl(names[0]),
        path.join(folder, 'upgrade-migrate.log'),
      );
      assert.deepEqual(
        (await pool.query<{ data: unknown }>(snapshotSql)).rows[0].data,
        before,
      );
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (!withPendingRequest)
          await client.query(
            "INSERT INTO cancellation_requests(id,meeting_id,requested_by_id,reason) VALUES($1,$2,$3,'Synthetic request')",
            [randomUUID(), meeting, actor],
          );
        await assert.rejects(
          client.query(
            "INSERT INTO cancellation_requests(id,meeting_id,requested_by_id,reason) VALUES($1,$2,$3,'Synthetic rival')",
            [randomUUID(), meeting, actor],
          ),
          (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '23505',
        );
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      assert.deepEqual(
        (await pool.query<{ data: unknown }>(snapshotSql)).rows[0].data,
        before,
      );
      writeFileSync(
        path.join(folder, 'migration-evidence.json'),
        JSON.stringify(
          {
            ownedDisposableTargetVerified: true,
            nonemptyMeetingUserAccessAuditOutboxPreserved: true,
            preUpgradeBackupRestoreVerified: true,
            pendingUniqueConstraintVerified: true,
            historicalMigrationsUnchanged: true,
            targetMigration,
            existingPendingRequestReceiptAuditIntentPreserved:
              withPendingRequest,
          },
          null,
          2,
        ),
      );
    } finally {
      await pool.end();
    }
  } catch (error) {
    failures.push(error);
  }
  for (const name of owned) {
    try {
      assert(/^mw_cancel_(upgrade|restore)_[a-f0-9]{32}$/.test(name));
      docker([
        'exec',
        containerId,
        'dropdb',
        '--if-exists',
        '--force',
        '-U',
        'postgres',
        name,
      ]);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    const codes = failures.map((error) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Z0-9_]+$/.test(error.code)
        ? error.code
        : 'UNCLASSIFIED',
    );
    writeFileSync(
      path.join(folder, 'failure-codes.json'),
      JSON.stringify(codes),
    );
    throw new AggregateError(
      failures,
      'Cancellation upgrade rehearsal failed: ' + codes.join(','),
    );
  }
}
