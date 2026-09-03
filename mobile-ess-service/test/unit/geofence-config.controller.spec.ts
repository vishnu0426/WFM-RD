import { ForbiddenException } from '@nestjs/common';
import { GeofenceConfigController } from '../../src/geofence/geofence-config.controller';
import { RequestWithTokenClaims } from '../../src/auth/access-token.guard';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE_ID = '22222222-2222-4222-8222-222222222222';

function buildRequest(claims: unknown = { tenant_id: TENANT_ID, permissions: [], sub: 'user-1' }) {
  return { tokenClaims: claims } as RequestWithTokenClaims;
}

function buildRequestWithNoClaims(): RequestWithTokenClaims {
  return {} as RequestWithTokenClaims;
}

function buildController() {
  const geofenceVerification = { getConfigForEmployee: jest.fn().mockResolvedValue({ enabled: false }) };
  const tenantContext = { requireTenantId: jest.fn().mockReturnValue(TENANT_ID) };
  const employeeSession = { assertEmployeeIdMatchesSession: jest.fn().mockResolvedValue(undefined) };
  const controller = new GeofenceConfigController(
    geofenceVerification as never,
    tenantContext as never,
    employeeSession as never,
  );
  return { controller, geofenceVerification, employeeSession };
}

describe('GeofenceConfigController.getConfig (ADR-0150/ADR-0157)', () => {
  it('verifies the employeeId against the session before returning config', async () => {
    const { controller, geofenceVerification, employeeSession } = buildController();

    await controller.getConfig({ employeeId: EMPLOYEE_ID } as never, buildRequest());

    expect(employeeSession.assertEmployeeIdMatchesSession).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-1' }),
      EMPLOYEE_ID,
    );
    expect(geofenceVerification.getConfigForEmployee).toHaveBeenCalledWith(TENANT_ID, EMPLOYEE_ID);
  });

  it('rejects when the employeeId does not match the session', async () => {
    const { controller, geofenceVerification, employeeSession } = buildController();
    employeeSession.assertEmployeeIdMatchesSession = jest.fn().mockRejectedValue(new ForbiddenException('mismatch'));

    await expect(controller.getConfig({ employeeId: EMPLOYEE_ID } as never, buildRequest())).rejects.toThrow(
      ForbiddenException,
    );
    expect(geofenceVerification.getConfigForEmployee).not.toHaveBeenCalled();
  });

  it('rejects when the request has no token claims at all', async () => {
    const { controller, geofenceVerification } = buildController();

    await expect(
      controller.getConfig({ employeeId: EMPLOYEE_ID } as never, buildRequestWithNoClaims()),
    ).rejects.toThrow(ForbiddenException);
    expect(geofenceVerification.getConfigForEmployee).not.toHaveBeenCalled();
  });
});
