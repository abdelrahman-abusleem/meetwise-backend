import { createHash, timingSafeEqual } from 'node:crypto';
import { isUUID } from 'class-validator';

export function administrativeResetIdentity(
  credential: unknown,
): string | undefined {
  if (typeof credential !== 'string' || credential.length !== 80)
    return undefined;
  const [userId, secret] = credential.split('.');
  return isUUID(userId) && /^[A-Za-z0-9_-]{43}$/.test(secret ?? '')
    ? userId
    : undefined;
}

export function administrativeResetDigest(credential: string): string {
  return createHash('sha256')
    .update('meetwise:administrative-reset:v1:')
    .update(credential)
    .digest('hex');
}

export function matchesAdministrativeResetDigest(
  credential: string,
  digest: string,
): boolean {
  return (
    /^[a-f0-9]{64}$/.test(digest) &&
    timingSafeEqual(
      Buffer.from(administrativeResetDigest(credential), 'hex'),
      Buffer.from(digest, 'hex'),
    )
  );
}
