import { SystemRole } from '@meetwise/infrastructure/database';
import { mayProvisionRole } from './provisioning.policy';
describe('System provisioning authority', () => {
  const roles = [SystemRole.OWNER, SystemRole.MANAGER, SystemRole.MEMBER];
  it.each(roles.flatMap((a) => roles.map((b) => [a, b] as const)))(
    '%s -> %s follows approved MW047',
    (a, b) => {
      expect(mayProvisionRole(a, b)).toBe(
        (a === SystemRole.OWNER && b !== SystemRole.OWNER) ||
          (a === SystemRole.MANAGER && b === SystemRole.MEMBER),
      );
    },
  );
});
