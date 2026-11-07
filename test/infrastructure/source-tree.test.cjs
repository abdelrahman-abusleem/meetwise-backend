const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('the published tree excludes product licensing and internal directories', () => {
  const tracked = fs.existsSync(path.join(root, '.git'))
    ? execFileSync('git', ['ls-files', '-z'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      })
        .split('\0')
        .filter(Boolean)
    : null;
  for (const relative of [
    'apps/api/src/modules/license',
    'docs',
    'rules',
    '.agents',
    '.codex',
    '.glm',
    'skills',
    'agents',
  ]) {
    const present = tracked
      ? tracked.some(
          (file) => file === relative || file.startsWith(relative + '/'),
        )
      : fs.existsSync(path.join(root, relative));
    assert.equal(present, false, relative);
  }
});

test('ignored local documentation cannot be accidentally added', () => {
  const entries = new Set(read('.gitignore').split(/\r?\n/));
  for (const entry of ['/docs/', '/rules/']) {
    assert(entries.has(entry), entry);
  }
});

test('licensing configuration and public database enum exports are absent', () => {
  assert(!read('.env.example').includes('LICENSE_PUBLIC_KEY_PATH'));
  assert(
    !read('libs/infrastructure/config/src/env.validation.ts').includes(
      'LICENSE_PUBLIC_KEY_PATH',
    ),
  );
  assert(
    !read('libs/infrastructure/database/src/index.ts').includes(
      'LicenseStatus',
    ),
  );
  assert(
    !read('libs/infrastructure/database/src/index.ts').includes(
      'LicenseEdition',
    ),
  );
  assert(!read('apps/api/src/api.module.ts').includes('LicenseModule'));
});

test('historical schema remains while setup and scoped API modules are retained', () => {
  assert.match(read('prisma/schema.prisma'), /model License\s*\{/);
  const api = read('apps/api/src/api.module.ts');
  for (const module of [
    'AuthModule',
    'SetupModule',
    'DepartmentMembershipsModule',
    'MeetingsModule',
    'SystemSettingsModule',
  ]) {
    assert(api.includes(module), module);
  }
  assert(!/\]\(docs\//.test(read('README.md')));
});
