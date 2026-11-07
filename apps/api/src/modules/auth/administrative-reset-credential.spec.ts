import { randomBytes, randomUUID } from 'node:crypto';
import {
  administrativeResetDigest,
  administrativeResetIdentity,
  matchesAdministrativeResetDigest,
} from './administrative-reset-credential';
import { ownerRecoveryDigest } from '../../../../recovery/src/owner-recovery-credential';
describe('Administrative reset credential boundary', () => {
  const userId = randomUUID(),
    credential = userId + '.' + randomBytes(32).toString('base64url');
  it('accepts the expected 256-bit credential shape and compares digest without plaintext persistence', () => {
    expect(administrativeResetIdentity(credential)).toBe(userId);
    expect(
      matchesAdministrativeResetDigest(
        credential,
        administrativeResetDigest(credential),
      ),
    ).toBe(true);
    expect(
      matchesAdministrativeResetDigest(
        credential,
        ownerRecoveryDigest(credential),
      ),
    ).toBe(false);
  });
  it.each([
    null,
    {},
    '',
    'invalid',
    credential + '.extra',
    credential.slice(0, -1),
    credential.slice(0, -1) + '!',
  ])('rejects malformed credential %p', (value) => {
    expect(administrativeResetIdentity(value)).toBeUndefined();
  });
  it.each(['', 'nothex', 'a'.repeat(63), 'Z'.repeat(64)])(
    'rejects malformed stored digest %s',
    (digest) => {
      expect(matchesAdministrativeResetDigest(credential, digest)).toBe(false);
    },
  );
});
