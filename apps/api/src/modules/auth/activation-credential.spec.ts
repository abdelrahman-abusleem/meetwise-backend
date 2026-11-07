import { randomUUID } from 'node:crypto';
import {
  activationCredential,
  activationDigest,
  activationIdentity,
  matchesActivationDigest,
} from './activation-credential';
import { administrativeResetDigest } from './administrative-reset-credential';
describe('Account activation credential boundary', () => {
  const id = randomUUID(),
    credential = activationCredential(id);
  it('issues256bit credential and separates reset purpose', () => {
    expect(credential).toHaveLength(80);
    expect(activationIdentity(credential)).toBe(id);
    expect(
      matchesActivationDigest(credential, activationDigest(credential)),
    ).toBe(true);
    expect(
      matchesActivationDigest(
        credential,
        administrativeResetDigest(credential),
      ),
    ).toBe(false);
    expect(matchesActivationDigest(credential, 'invalid')).toBe(false);
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
    expect(activationIdentity(value)).toBeUndefined();
  });
});
