import {
  mayManageMembership,
  isSystemMembershipOperator,
} from './membership.policy';
describe('Scoped membership non-escalation', () => {
  it.each(['OWNER', 'MANAGER'] as const)(
    '%s may manage scoped administrators',
    (role) => {
      expect(isSystemMembershipOperator(role)).toBe(true);
      expect(mayManageMembership(role, undefined, 'ADMIN', 'ADMIN', true)).toBe(
        true,
      );
    },
  );
  it('limits Department ADMIN to other MEMBER grants in its own authorized scope', () => {
    expect(
      mayManageMembership('MEMBER', 'ADMIN', 'MEMBER', 'MEMBER', false),
    ).toBe(true);
    expect(
      mayManageMembership('MEMBER', 'ADMIN', undefined, 'MEMBER', false),
    ).toBe(true);
  });
  it.each([
    ['ADMIN', 'ADMIN', 'MEMBER', false],
    ['ADMIN', 'MEMBER', 'ADMIN', false],
    ['ADMIN', 'MEMBER', 'MEMBER', true],
    ['MEMBER', 'MEMBER', 'MEMBER', false],
    [undefined, 'MEMBER', 'MEMBER', false],
  ] as const)(
    'denies peer/self/escalation/ordinary grants %p %p %p',
    (actor, current, next, self) => {
      expect(mayManageMembership('MEMBER', actor, current, next, self)).toBe(
        false,
      );
    },
  );
});
