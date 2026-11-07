import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateWizardDraftDto, readConfig } from './wizard-config.dto';
const errors = (config: unknown) =>
  validateSync(plainToInstance(CreateWizardDraftDto, { config }), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
describe('Wizard draft allowlist', () => {
  it.each([
    null,
    [],
    { companyName: null },
    { providerApiKey: 'synthetic' },
    { timezone: '+01:00' },
    { departmentPlans: [null] },
  ])('rejects malformed config %p', (config) =>
    expect(errors(config).length).toBeGreaterThan(0),
  );
  it('accepts incomplete non-secret configuration', () =>
    expect(errors({ timezone: 'UTC', defaultLanguage: 'ar' })).toHaveLength(0));
  it('fails closed on stored secret properties', () =>
    expect(() => readConfig({ providerApiKey: 'synthetic' })).toThrow(
      'Draft configuration unavailable',
    ));
});
