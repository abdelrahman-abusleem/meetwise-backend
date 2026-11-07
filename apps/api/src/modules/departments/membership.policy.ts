import type {
  SystemRole,
  DepartmentRole,
} from '@meetwise/infrastructure/database';
export function isSystemMembershipOperator(role: SystemRole): boolean {
  return role === 'OWNER' || role === 'MANAGER';
}
export function mayManageMembership(
  systemRole: SystemRole,
  actorRole: DepartmentRole | undefined,
  currentRole: DepartmentRole | undefined,
  nextRole: DepartmentRole | undefined,
  isSelf: boolean,
): boolean {
  return (
    isSystemMembershipOperator(systemRole) ||
    (actorRole === 'ADMIN' &&
      !isSelf &&
      currentRole !== 'ADMIN' &&
      nextRole !== 'ADMIN')
  );
}
