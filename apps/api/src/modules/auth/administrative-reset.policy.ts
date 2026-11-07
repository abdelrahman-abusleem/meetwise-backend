import { SystemRole } from '@meetwise/infrastructure/database';

export const ADMINISTRATIVE_RESET_TTL_MS = 15 * 60 * 1000;

export function mayAdministrativelyReset(
  issuer: SystemRole,
  target: SystemRole,
): boolean {
  return (
    (issuer === SystemRole.OWNER &&
      (target === SystemRole.MANAGER || target === SystemRole.MEMBER)) ||
    (issuer === SystemRole.MANAGER && target === SystemRole.MEMBER)
  );
}
