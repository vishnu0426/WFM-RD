import { ForbiddenException } from '@nestjs/common';
import { DevicesController } from '../../src/devices/devices.controller';
import { RequestWithTokenClaims } from '../../src/auth/access-token.guard';
import { DeviceType } from '../../src/devices/entities/device-registration.entity';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE_ID = '22222222-2222-4222-8222-222222222222';

function buildRequest(claims: unknown = { tenant_id: TENANT_ID, permissions: [], sub: 'user-1' }) {
  return { tokenClaims: claims } as RequestWithTokenClaims;
}

function buildRequestWithNoClaims(): RequestWithTokenClaims {
  return {} as RequestWithTokenClaims;
}

function buildController() {
  const devices = {
    register: jest.fn().mockResolvedValue({
      id: 'device-1',
      deviceType: DeviceType.IOS,
      active: true,
      lastActiveAt: new Date('2026-01-01T00:00:00.000Z'),
    }),
  };
  const tenantContext = { requireTenantId: jest.fn().mockReturnValue(TENANT_ID) };
  const employeeSession = { assertEmployeeIdMatchesSession: jest.fn().mockResolvedValue(undefined) };
  const controller = new DevicesController(devices as never, tenantContext as never, employeeSession as never);
  return { controller, devices, employeeSession };
}

const DTO = {
  employeeId: EMPLOYEE_ID,
  deviceType: DeviceType.IOS,
  deviceId: 'install-uuid-1',
  pushToken: 'token-1',
  appVersion: '1.0.0',
  biometricEnrolled: false,
} as never;

describe('DevicesController.register (ADR-0150/ADR-0157)', () => {
  it('verifies the employeeId against the session before registering', async () => {
    const { controller, devices, employeeSession } = buildController();

    await controller.register(DTO, buildRequest());

    expect(employeeSession.assertEmployeeIdMatchesSession).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-1' }),
      EMPLOYEE_ID,
    );
    expect(devices.register).toHaveBeenCalled();
  });

  it('rejects when the employeeId does not match the session', async () => {
    const { controller, devices, employeeSession } = buildController();
    employeeSession.assertEmployeeIdMatchesSession = jest.fn().mockRejectedValue(new ForbiddenException('mismatch'));

    await expect(controller.register(DTO, buildRequest())).rejects.toThrow(ForbiddenException);
    expect(devices.register).not.toHaveBeenCalled();
  });

  it('rejects when the request has no token claims at all', async () => {
    const { controller, devices } = buildController();

    await expect(controller.register(DTO, buildRequestWithNoClaims())).rejects.toThrow(ForbiddenException);
    expect(devices.register).not.toHaveBeenCalled();
  });
});
