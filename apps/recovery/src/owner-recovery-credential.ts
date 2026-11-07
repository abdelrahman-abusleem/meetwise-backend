import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isUUID } from 'class-validator';

export const OWNER_RECOVERY_TTL_MS = 15 * 60 * 1000;

export function issueOwnerRecoveryCredential(userId: string): string {
  if (!isUUID(userId)) throw new Error('Invalid recovery identity');
  return `${userId}.${randomBytes(32).toString('base64url')}`;
}

export function ownerRecoveryIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length !== 80) return undefined;
  const [userId, secret] = value.split('.');
  return isUUID(userId) && /^[A-Za-z0-9_-]{43}$/.test(secret ?? '')
    ? userId
    : undefined;
}

export function ownerRecoveryDigest(credential: string): string {
  return createHash('sha256')
    .update('meetwise:owner-recovery:v1:')
    .update(credential)
    .digest('hex');
}

export function matchesOwnerRecoveryDigest(
  credential: string,
  digest: string,
): boolean {
  return (
    /^[a-f0-9]{64}$/.test(digest) &&
    timingSafeEqual(
      Buffer.from(ownerRecoveryDigest(credential), 'hex'),
      Buffer.from(digest, 'hex'),
    )
  );
}
