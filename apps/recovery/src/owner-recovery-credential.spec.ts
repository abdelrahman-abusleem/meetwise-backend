import {
  issueOwnerRecoveryCredential,
  matchesOwnerRecoveryDigest,
  ownerRecoveryDigest,
  ownerRecoveryIdentity,
  OWNER_RECOVERY_TTL_MS,
} from './owner-recovery-credential';
import { randomUUID } from 'node:crypto';

describe('OWNER recovery credential boundary', () => {
  it('uses a separate 256-bit credential and fifteen-minute lifetime', () => {
    const id = randomUUID();
    const credential = issueOwnerRecoveryCredential(id);
    expect(ownerRecoveryIdentity(credential)).toBe(id);
    expect(credential.split('.')[1]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(OWNER_RECOVERY_TTL_MS).toBe(900000);
  });
  it('generates independent replacements', () => {
    const id = randomUUID();
    expect(issueOwnerRecoveryCredential(id)).not.toBe(
      issueOwnerRecoveryCredential(id),
    );
  });
  it('accepts only the matching purpose-bound digest', () => {
    const credential = issueOwnerRecoveryCredential(randomUUID());
    expect(
      matchesOwnerRecoveryDigest(credential, ownerRecoveryDigest(credential)),
    ).toBe(true);
    expect(
      matchesOwnerRecoveryDigest(
        credential + 'x',
        ownerRecoveryDigest(credential),
      ),
    ).toBe(false);
    expect(matchesOwnerRecoveryDigest(credential, 'malformed')).toBe(false);
  });
  it.each([
    undefined,
    null,
    123,
    {},
    '',
    'x'.repeat(100000),
    `${randomUUID()}.short`,
    'x'.repeat(43),
  ])('rejects malformed, oversized and bootstrap credentials', (value) => {
    expect(ownerRecoveryIdentity(value)).toBeUndefined();
  });
});
