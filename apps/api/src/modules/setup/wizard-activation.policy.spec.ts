import { completeWizardConfig } from './wizard-activation.policy';
describe('Wizard activation completeness', () => {
  const config = {
    companyName: 'Company',
    timezone: 'UTC',
    defaultLanguage: 'en' as const,
    defaultBotName: 'Bot',
    departmentChoice: 'TECH' as const,
    departmentPlans: [
      {
        kind: 'TECH' as const,
        operatorUserIds: ['00000000-0000-4000-8000-000000000001'],
      },
    ],
  };
  it('accepts explicit matching complete plan', () =>
    expect(completeWizardConfig(config).kinds).toEqual(['TECH']));
  it('rejects missing company settings', () =>
    expect(() =>
      completeWizardConfig({ ...config, companyName: undefined }),
    ).toThrow());
  it('requires both independent plans for BOTH', () =>
    expect(() =>
      completeWizardConfig({ ...config, departmentChoice: 'BOTH' }),
    ).toThrow());
  it('rejects extra plans outside chosen scope', () =>
    expect(() =>
      completeWizardConfig({ ...config, departmentChoice: 'SALES' }),
    ).toThrow());
});
