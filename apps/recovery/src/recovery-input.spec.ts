import { Readable } from 'node:stream';
import { readOwnerRecoveryInput } from './recovery-input';

describe('OWNER recovery stdin boundary', () => {
  it('preserves Arabic and emoji at every possible byte split', async () => {
    const input = {
      credential: 'synthetic-credential',
      newPassword: 'Synthetic-عربي-🔐-739!',
    };
    const bytes = Buffer.from(JSON.stringify(input), 'utf8');
    for (let split = 1; split < bytes.length; split++) {
      const stream = Readable.from([
        bytes.subarray(0, split),
        bytes.subarray(split),
      ]);
      await expect(readOwnerRecoveryInput(stream)).resolves.toEqual(input);
    }
  });
  it('rejects malformed or truncated UTF-8 instead of replacing password bytes', async () => {
    await expect(
      readOwnerRecoveryInput(
        Readable.from([
          Buffer.from('{"credential":"x","newPassword":"'),
          Buffer.from([0xc3]),
        ]),
      ),
    ).rejects.toThrow();
    await expect(
      readOwnerRecoveryInput(Readable.from([Buffer.from([0xff, 0xfe])])),
    ).rejects.toThrow();
  });
  it('bounds bytes before decoding or parsing even for multibyte input', async () => {
    await expect(
      readOwnerRecoveryInput(Readable.from([Buffer.alloc(8193, 32)])),
    ).rejects.toThrow('Input too large');
    await expect(
      readOwnerRecoveryInput(Readable.from(['ع'.repeat(4097)])),
    ).rejects.toThrow('Input too large');
  });
  it.each([
    'null',
    '[]',
    'false',
    '{}',
    '{',
    '{"credential":1,"newPassword":"x"}',
    '{"credential":"x","newPassword":"x","extra":true}',
    '{"credential":"x","newPassword":"x","__proto__":{}}',
  ])('rejects malformed/unexpected JSON', async (text) => {
    await expect(
      readOwnerRecoveryInput(Readable.from([Buffer.from(text)])),
    ).rejects.toThrow();
  });
});
