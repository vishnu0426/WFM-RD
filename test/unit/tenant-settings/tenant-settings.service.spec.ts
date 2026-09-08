import { TenantSettingsService } from '../../../src/modules/tenant-settings/tenant-settings.service';
import { TenantSettings } from '../../../src/modules/tenant-settings/entities/tenant-settings.entity';

function makeSettings(overrides: Partial<TenantSettings> = {}): TenantSettings {
  return {
    id: 'settings-1',
    tenantId: 'tenant-1',
    smtpHost: null,
    smtpPort: null,
    smtpUsername: null,
    smtpPassword: null,
    smtpFromAddress: null,
    smtpUseTls: true,
    passwordMinLength: 12,
    passwordRequireUppercase: true,
    passwordRequireNumber: true,
    passwordRequireSymbol: false,
    passwordExpiryDays: null,
    sessionTimeoutMinutes: 60,
    mfaRequired: false,
    brandLogoUrl: null,
    timezone: 'UTC',
    locale: 'en-US',
    dataRetentionDays: 365,
    selfIdentificationProperties: [],
    weekStartDay: null,
    dayBoundary: null,
    schedulingIntervalMinutes: null,
    planningPeriodWeeks: null,
    defaultShiftDurationHours: null,
    forecastingIntervalMinutes: null,
    historicalDataWindowWeeks: null,
    forecastingPlanningHorizonWeeks: null,
    attendanceGracePeriodMinutes: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('TenantSettingsService', () => {
  const makeDeps = () => ({
    repository: {
      getOrCreate: jest.fn(),
      save: jest.fn(),
    },
    // No baseline configured (assertWithinBaseline no-ops) unless a test overrides this.
    platformSecurityBaseline: {
      assertWithinBaseline: jest.fn().mockResolvedValue(undefined),
    },
  });

  const makeService = (deps: ReturnType<typeof makeDeps>) =>
    new TenantSettingsService(deps.repository as never, deps.platformSecurityBaseline as never);

  it('getSettings never exposes smtpPassword, only a boolean flag', async () => {
    const deps = makeDeps();
    deps.repository.getOrCreate.mockResolvedValue(makeSettings({ smtpPassword: 'super-secret' }));
    const view = await makeService(deps).getSettings();

    expect(view).not.toHaveProperty('smtpPassword');
    expect(view.smtpPasswordSet).toBe(true);
  });

  it('getSettings reports smtpPasswordSet: false when no password is configured', async () => {
    const deps = makeDeps();
    deps.repository.getOrCreate.mockResolvedValue(makeSettings({ smtpPassword: null }));
    const view = await makeService(deps).getSettings();

    expect(view.smtpPasswordSet).toBe(false);
  });

  it('updateEmailSettings overwrites the password when a new one is provided', async () => {
    const deps = makeDeps();
    deps.repository.getOrCreate.mockResolvedValue(makeSettings({ smtpPassword: 'old-secret' }));
    deps.repository.save.mockImplementation(async (entity: TenantSettings) => entity);

    await makeService(deps).updateEmailSettings({ smtpHost: 'smtp.example.com', smtpPassword: 'new-secret' });

    const saved = deps.repository.save.mock.calls[0][0] as TenantSettings;
    expect(saved.smtpHost).toBe('smtp.example.com');
    expect(saved.smtpPassword).toBe('new-secret');
  });

  it('updateEmailSettings leaves the existing password untouched when omitted', async () => {
    const deps = makeDeps();
    deps.repository.getOrCreate.mockResolvedValue(makeSettings({ smtpPassword: 'old-secret' }));
    deps.repository.save.mockImplementation(async (entity: TenantSettings) => entity);

    await makeService(deps).updateEmailSettings({ smtpHost: 'smtp.example.com' });

    const saved = deps.repository.save.mock.calls[0][0] as TenantSettings;
    expect(saved.smtpHost).toBe('smtp.example.com');
    expect(saved.smtpPassword).toBe('old-secret');
  });

  it('updateSecurityPolicy only overwrites the fields provided, not the whole row', async () => {
    const deps = makeDeps();
    deps.repository.getOrCreate.mockResolvedValue(
      makeSettings({ passwordMinLength: 12, mfaRequired: false, sessionTimeoutMinutes: 60 }),
    );
    deps.repository.save.mockImplementation(async (entity: TenantSettings) => entity);

    await makeService(deps).updateSecurityPolicy({ mfaRequired: true });

    const saved = deps.repository.save.mock.calls[0][0] as TenantSettings;
    expect(saved.mfaRequired).toBe(true);
    expect(saved.passwordMinLength).toBe(12);
    expect(saved.sessionTimeoutMinutes).toBe(60);
  });

  it('updateGeneralSettings only overwrites the fields provided', async () => {
    const deps = makeDeps();
    deps.repository.getOrCreate.mockResolvedValue(makeSettings({ timezone: 'UTC', locale: 'en-US' }));
    deps.repository.save.mockImplementation(async (entity: TenantSettings) => entity);

    await makeService(deps).updateGeneralSettings({ timezone: 'America/New_York' });

    const saved = deps.repository.save.mock.calls[0][0] as TenantSettings;
    expect(saved.timezone).toBe('America/New_York');
    expect(saved.locale).toBe('en-US');
  });

  it('updateSelfIdentification replaces the whole ordered property list', async () => {
    const deps = makeDeps();
    deps.repository.getOrCreate.mockResolvedValue(makeSettings({ selfIdentificationProperties: ['email'] }));
    deps.repository.save.mockImplementation(async (entity: TenantSettings) => entity);

    const view = await makeService(deps).updateSelfIdentification({
      properties: ['family_name', 'given_name'],
    });

    expect(view.selfIdentificationProperties).toEqual(['family_name', 'given_name']);
  });
});
