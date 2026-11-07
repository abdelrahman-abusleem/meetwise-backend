const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { randomBytes } = require('node:crypto');
const {
  TranscriptFileKeys,
} = require('../../src/infrastructure/transcript-file-keys.ts');
function fixture(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-synthetic-keys-'));
  const file = path.join(dir, 'synthetic-keyring.json');
  try {
    callback(file);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
}
test('loads only an explicit external keyring, preserving old versions for restoration', () =>
  fixture((file) => {
    const first = randomBytes(32),
      second = randomBytes(32);
    fs.writeFileSync(
      file,
      JSON.stringify({
        activeVersion: 'v2',
        keys: { v1: first.toString('base64'), v2: second.toString('base64') },
      }),
      { mode: 0o600 },
    );
    const keys = new TranscriptFileKeys(() => file);
    assert.equal(keys.activeVersion(), 'v2');
    assert.deepEqual(keys.keyFor('v1'), first);
    assert.deepEqual(keys.keyFor('v2'), second);
    assert.equal(keys.keyFor('missing'), undefined);
  }));
test('fails closed for missing/relative/network key paths without creating replacement keys', () => {
  for (const value of [
    undefined,
    'relative.json',
    '\\\\unidentified-host\\secret.json',
  ])
    assert.throws(() => new TranscriptFileKeys(() => value).activeVersion(), {
      message: 'Transcript encryption key unavailable',
    });
});
test('rejects malformed JSON, invalid key lengths and absent active version', () =>
  fixture((file) => {
    for (const value of [
      'invalid-json',
      '{}',
      JSON.stringify({
        activeVersion: 'v2',
        keys: { v1: randomBytes(32).toString('base64') },
      }),
      JSON.stringify({ activeVersion: 'v1', keys: { v1: 'short' } }),
    ]) {
      fs.writeFileSync(file, value, { mode: 0o600 });
      assert.throws(() => new TranscriptFileKeys(() => file).activeVersion(), {
        message: 'Transcript encryption key unavailable',
      });
    }
  }));
test('does not accept a directory or an oversized key file', () =>
  fixture((file) => {
    assert.throws(
      () => new TranscriptFileKeys(() => path.dirname(file)).activeVersion(),
      /key unavailable/,
    );
    fs.writeFileSync(file, Buffer.alloc(65_537), { mode: 0o600 });
    assert.throws(
      () => new TranscriptFileKeys(() => file).activeVersion(),
      /key unavailable/,
    );
  }));
