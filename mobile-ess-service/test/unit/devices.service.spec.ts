import { DataSource, EntityManager, Repository } from 'typeorm';
import { DevicesService } from '../../src/devices/devices.service';
import { DeviceRegistration, DeviceType } from '../../src/devices/entities/device-registration.entity';
import { RegisterDeviceRequestDto } from '../../src/devices/dto/register-device-request.dto';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_INSTALL_ID = 'install-uuid-1';

class FakeUniqueViolation extends Error {
  code = '23505';
}

function buildDto(overrides: Partial<RegisterDeviceRequestDto> = {}): RegisterDeviceRequestDto {
  return {
    employeeId: EMPLOYEE_ID,
    deviceType: DeviceType.IOS,
    deviceId: DEVICE_INSTALL_ID,
    pushToken: 'ExponentPushToken[abc123]',
    appVersion: '1.0.0',
    biometricEnrolled: true,
    ...overrides,
  };
}

function buildRow(overrides: Partial<DeviceRegistration> = {}): DeviceRegistration {
  const row = new DeviceRegistration();
  row.id = DEVICE_ID;
  row.tenantId = TENANT_ID;
  row.employeeId = EMPLOYEE_ID;
  row.deviceType = DeviceType.IOS;
  row.deviceId = DEVICE_INSTALL_ID;
  row.pushToken = 'ExponentPushToken[old]';
  row.appVersion = '0.9.0';
  row.biometricEnrolled = false;
  row.active = true;
  row.lastActiveAt = new Date('2026-08-01T00:00:00.000Z');
  row.createdAt = new Date('2026-08-01T00:00:00.000Z');
  return Object.assign(row, overrides);
}

/**
 * `DevicesService` routes every query through `withTenantConnection`
 * (`dataSource.transaction(...)`, see that helper's own doc comment on why
 * - RLS's `app.current_tenant_id` GUC). Same fake-transaction pattern
 * `attendance-ingestion.service.spec.ts` uses: `DataSource.transaction` is
 * faked to invoke the callback with a mocked `EntityManager` whose
 * `getRepository` returns a mocked `Repository`, so these assertions
 * exercise the real service logic without a live Postgres.
 */
function buildService() {
  const repo = {
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    create: jest.fn((v: Partial<DeviceRegistration>) => v as DeviceRegistration),
    save: jest.fn((v: Partial<DeviceRegistration>) => Promise.resolve({ id: DEVICE_ID, ...v } as DeviceRegistration)),
    find: jest.fn(),
    update: jest.fn(),
  } as unknown as jest.Mocked<Repository<DeviceRegistration>>;
  const manager = { getRepository: jest.fn().mockReturnValue(repo), query: jest.fn().mockResolvedValue(undefined) };
  const dataSource = {
    transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
      work(manager as unknown as EntityManager),
    ),
  } as unknown as DataSource;
  const service = new DevicesService(dataSource);
  return { repo, service };
}

describe('DevicesService.register', () => {
  it('creates a new row when no existing device matches (tenant, employee, deviceType)', async () => {
    const { repo, service } = buildService();
    repo.findOne = jest.fn().mockResolvedValue(null);

    const result = await service.register(TENANT_ID, buildDto());

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        employeeId: EMPLOYEE_ID,
        deviceType: DeviceType.IOS,
        pushToken: 'ExponentPushToken[abc123]',
        appVersion: '1.0.0',
        biometricEnrolled: true,
        active: true,
      }),
    );
    expect(result.active).toBe(true);
  });

  it('upserts (refreshes pushToken/appVersion/biometricEnrolled/lastActiveAt) on a repeat call for the same key', async () => {
    const existing = buildRow();
    const { repo, service } = buildService();
    repo.findOne = jest.fn().mockResolvedValue(existing);

    const result = await service.register(
      TENANT_ID,
      buildDto({ pushToken: 'ExponentPushToken[new]', appVersion: '1.1.0', biometricEnrolled: true }),
    );

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: DEVICE_ID,
        pushToken: 'ExponentPushToken[new]',
        appVersion: '1.1.0',
        biometricEnrolled: true,
      }),
    );
    expect(result.pushToken).toBe('ExponentPushToken[new]');
  });

  it('reactivates a previously dead-tokened device on a fresh registerDevice call', async () => {
    const existing = buildRow({ active: false });
    const { repo, service } = buildService();
    repo.findOne = jest.fn().mockResolvedValue(existing);

    const result = await service.register(TENANT_ID, buildDto());

    expect(result.active).toBe(true);
  });

  it('two different deviceTypes for the same employee produce two independent rows', async () => {
    const { repo, service } = buildService();
    repo.findOne = jest.fn().mockResolvedValue(null);

    await service.register(TENANT_ID, buildDto({ deviceType: DeviceType.IOS }));
    await service.register(TENANT_ID, buildDto({ deviceType: DeviceType.ANDROID }));

    expect(repo.findOne).toHaveBeenNthCalledWith(1, {
      where: { tenantId: TENANT_ID, employeeId: EMPLOYEE_ID, deviceType: DeviceType.IOS, deviceId: DEVICE_INSTALL_ID },
    });
    expect(repo.findOne).toHaveBeenNthCalledWith(2, {
      where: {
        tenantId: TENANT_ID,
        employeeId: EMPLOYEE_ID,
        deviceType: DeviceType.ANDROID,
        deviceId: DEVICE_INSTALL_ID,
      },
    });
  });

  it('two devices of the same employee/platform, distinguished only by deviceId, produce two independent rows (Module 11 Gap 2)', async () => {
    const { repo, service } = buildService();
    repo.findOne = jest.fn().mockResolvedValue(null);

    await service.register(TENANT_ID, buildDto({ deviceId: 'install-uuid-1' }));
    await service.register(TENANT_ID, buildDto({ deviceId: 'install-uuid-2' }));

    expect(repo.findOne).toHaveBeenNthCalledWith(1, {
      where: { tenantId: TENANT_ID, employeeId: EMPLOYEE_ID, deviceType: DeviceType.IOS, deviceId: 'install-uuid-1' },
    });
    expect(repo.findOne).toHaveBeenNthCalledWith(2, {
      where: { tenantId: TENANT_ID, employeeId: EMPLOYEE_ID, deviceType: DeviceType.IOS, deviceId: 'install-uuid-2' },
    });
  });

  it('reloads and upserts on a genuinely concurrent insert race (unique violation)', async () => {
    const { repo, service } = buildService();
    const existing = buildRow();
    repo.findOne = jest.fn().mockResolvedValue(null);
    repo.save = jest
      .fn()
      .mockRejectedValueOnce(new FakeUniqueViolation())
      .mockResolvedValueOnce({ ...existing, pushToken: 'ExponentPushToken[raced]' } as DeviceRegistration);
    repo.findOneOrFail = jest.fn().mockResolvedValue(existing);

    const result = await service.register(TENANT_ID, buildDto({ pushToken: 'ExponentPushToken[raced]' }));

    expect(repo.findOneOrFail).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, employeeId: EMPLOYEE_ID, deviceType: DeviceType.IOS, deviceId: DEVICE_INSTALL_ID },
    });
    expect(result.pushToken).toBe('ExponentPushToken[raced]');
  });

  it('re-throws a non-unique-violation error from the initial insert', async () => {
    const { repo, service } = buildService();
    repo.findOne = jest.fn().mockResolvedValue(null);
    repo.save = jest.fn().mockRejectedValueOnce(new Error('connection reset'));

    await expect(service.register(TENANT_ID, buildDto())).rejects.toThrow('connection reset');
  });
});

describe('DevicesService.findActiveForEmployee', () => {
  it('only queries active=true rows', async () => {
    const { repo, service } = buildService();
    repo.find = jest.fn().mockResolvedValue([]);

    await service.findActiveForEmployee(TENANT_ID, EMPLOYEE_ID);

    expect(repo.find).toHaveBeenCalledWith({ where: { tenantId: TENANT_ID, employeeId: EMPLOYEE_ID, active: true } });
  });
});

describe('DevicesService.markInactive', () => {
  it('soft-updates active=false rather than deleting the row', async () => {
    const { repo, service } = buildService();

    await service.markInactive(TENANT_ID, DEVICE_ID);

    expect(repo.update).toHaveBeenCalledWith({ id: DEVICE_ID }, { active: false });
  });
});
