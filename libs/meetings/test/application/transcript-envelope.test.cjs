const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const {
  TranscriptEnvelope,
} = require('../../src/infrastructure/transcript-envelope.ts');
const key = randomBytes(32);
function provider(active = 'v1', keys = new Map([['v1', key]])) {
  return {
    activeVersion: () => active,
    keyFor: (version) => keys.get(version),
  };
}
const binding = {
  recordId: 'synthetic-event',
  purpose: 'transcript-inbox',
  meetingId: 'meeting-a',
  botSessionId: 'session-a',
};
test('encrypts text and speaker evidence, with fresh DEKs/nonces and restart recovery', () => {
  const cipher = new TranscriptEnvelope(provider());
  const plain = JSON.stringify({
    text: 'synthetic private phrase',
    speaker: 'synthetic speaker',
  });
  const first = cipher.seal(plain, binding),
    second = cipher.seal(plain, binding);
  assert.notDeepEqual(first, second);
  assert(!JSON.stringify(first).includes('synthetic private phrase'));
  assert.equal(new TranscriptEnvelope(provider()).open(first, binding), plain);
});
for (const field of [
  'ciphertext',
  'tag',
  'nonce',
  'wrappedKey',
  'wrapTag',
  'wrapNonce',
]) {
  test('rejects modified ' + field + ' with a fixed error', () => {
    const cipher = new TranscriptEnvelope(provider());
    const value = cipher.seal('synthetic secret', binding);
    const bytes = Buffer.from(value[field], 'base64');
    bytes[0] ^= 1;
    assert.throws(
      () =>
        cipher.open({ ...value, [field]: bytes.toString('base64') }, binding),
      { message: 'Transcript encrypted record unavailable' },
    );
  });
}
test('binds both layers to record, purpose, version and key version', () => {
  const cipher = new TranscriptEnvelope(provider());
  const value = cipher.seal('synthetic', binding);
  for (const other of ['recordId', 'purpose', 'meetingId', 'botSessionId'].map(
    (field) => ({ ...binding, [field]: 'different' }),
  ))
    assert.throws(
      () => cipher.open(value, other),
      /encrypted record unavailable/,
    );
  assert.throws(
    () => cipher.open({ ...value, version: 2 }, binding),
    /encrypted record unavailable/,
  );
  assert.throws(
    () => cipher.open({ ...value, keyVersion: 'different' }, binding),
    /encrypted record unavailable/,
  );
});
test('retains old-key recovery and fails closed without the historical key', () => {
  const old = new TranscriptEnvelope(provider()).seal('old synthetic', binding);
  const keys = new Map([
    ['v1', key],
    ['v2', randomBytes(32)],
  ]);
  assert.equal(
    new TranscriptEnvelope(provider('v2', keys)).open(old, binding),
    'old synthetic',
  );
  assert.throws(
    () =>
      new TranscriptEnvelope(
        provider('v2', new Map([['v2', keys.get('v2')]])),
      ).open(old, binding),
    /encrypted record unavailable/,
  );
});
test('rejects absent or wrong-size KEK and malformed envelopes without detail disclosure', () => {
  for (const invalid of [undefined, Buffer.alloc(31), Buffer.alloc(33)])
    assert.throws(
      () =>
        new TranscriptEnvelope(provider('v1', new Map([['v1', invalid]]))).seal(
          'sensitive',
          binding,
        ),
      { message: 'Transcript encryption key unavailable' },
    );
  const cipher = new TranscriptEnvelope(provider());
  for (const invalid of [
    null,
    {},
    [],
    { version: 1 },
    { ...cipher.seal('synthetic', binding), nonce: 'not-base64' },
  ])
    assert.throws(() => cipher.open(invalid, binding), {
      message: 'Transcript encrypted record unavailable',
    });
});
