import { SystemRole } from '@meetwise/infrastructure/database';
export const ACTIVATION_TTL_MS = 24 * 60 * 60 * 1000;
export function mayProvisionRole(
  issuer: SystemRole,
  target: SystemRole,
): boolean {
  return (
    (issuer === SystemRole.OWNER &&
      (target === SystemRole.MANAGER || target === SystemRole.MEMBER)) ||
    (issuer === SystemRole.MANAGER && target === SystemRole.MEMBER)
  );
}
