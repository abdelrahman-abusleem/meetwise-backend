import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isUUID } from 'class-validator';
export function activationCredential(userId: string): string {
  return userId + '.' + randomBytes(32).toString('base64url');
}
export function activationIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length !== 80) return;
  const [id, secret] = value.split('.');
  return isUUID(id) && /^[A-Za-z0-9_-]{43}$/.test(secret ?? '')
    ? id
    : undefined;
}
export function activationDigest(value: string): string {
  return createHash('sha256')
    .update('meetwise:account-activation:v1:')
    .update(value)
    .digest('hex');
}
export function matchesActivationDigest(
  value: string,
  digest: string,
): boolean {
  return (
    /^[a-f0-9]{64}$/.test(digest) &&
    timingSafeEqual(
      Buffer.from(activationDigest(value), 'hex'),
      Buffer.from(digest, 'hex'),
    )
  );
}
