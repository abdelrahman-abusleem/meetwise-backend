import { draftExpiry } from './wizard-draft.policy';
describe('Approved wizard draft lifetime', () => {
  const day = 86400000,
    created = new Date('2026-01-01T00:00:00Z');
  it('starts with24h inactivity allowance', () =>
    expect(draftExpiry(created, created).getTime()).toBe(
      created.getTime() + day,
    ));
  it('renews from successful activity', () =>
    expect(
      draftExpiry(created, new Date(created.getTime() + day)).getTime(),
    ).toBe(created.getTime() + 2 * day));
  it('never extends beyond seven days', () =>
    expect(
      draftExpiry(created, new Date(created.getTime() + 6.5 * day)).getTime(),
    ).toBe(created.getTime() + 7 * day));
});
