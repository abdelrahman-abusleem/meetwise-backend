import { SystemRole } from '@meetwise/infrastructure/database';
import { mayAdministrativelyReset } from './administrative-reset.policy';

describe('Administrative reset role matrix', () => {
  const roles = [SystemRole.OWNER, SystemRole.MANAGER, SystemRole.MEMBER];
  it.each(
    roles.flatMap((issuer) => roles.map((target) => [issuer, target] as const)),
  )('%s may reset %s only under the approved matrix', (issuer, target) => {
    const expected =
      issuer === SystemRole.OWNER
        ? target === SystemRole.MANAGER || target === SystemRole.MEMBER
        : issuer === SystemRole.MANAGER && target === SystemRole.MEMBER;
    expect(mayAdministrativelyReset(issuer, target)).toBe(expected);
  });
});
