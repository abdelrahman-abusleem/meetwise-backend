import { SetMetadata } from '@nestjs/common';
import { SystemRole } from '@meetwise/infrastructure/database';

export const SYSTEM_ROLES_KEY = 'meetwise:system-roles';
export const RequireSystemRoles = (...roles: SystemRole[]) =>
  SetMetadata(SYSTEM_ROLES_KEY, Object.freeze(roles));
