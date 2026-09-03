import { ForbiddenException } from '@nestjs/common';
import { MobileSyncController } from '../../src/mobile-sync/mobile-sync.controller';
import { RequestWithTokenClaims } from '../../src/auth/access-token.guard';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_EMPLOYEE_ID = '33333333-3333-4333-8333-333333333333';

const AUTHENTICATED_CLAIMS = { tenant_id: TENANT_ID, permissions: [], sub: 'user-1' };

function buildRequest(claims: unknown = AUTHENTICATED_CLAIMS) {
  return { tokenClaims: claims } as RequestWithTokenClaims;
}

function buildRequestWithNoClaims(): RequestWithTokenClaims {
  return {} as RequestWithTokenClaims;
}

function buildController() {
  const mobileSync = { syncBatch: jest.fn().mockResolvedValue([]) };
  const tenantContext = { requireTenantId: jest.fn().mockReturnValue(TENANT_ID) };
  const employeeSession = { assertEmployeeIdMatchesSession: jest.fn().mockResolvedValue(undefined) };
  const controller = new MobileSyncController(mobileSync as never, tenantContext as never, employeeSession as never);
  return { controller, mobileSync, tenantContext, employeeSession };
}

function buildDto(employeeIds: string[]) {
  return {
    deviceId: 'device-1',
    actions: employeeIds.map((employeeId, index) => ({
      id: `action-${index}`,
      employeeId,
      actionType: 'clock_in',
      payload: {},
      createdAtDevice: '2026-01-01T00:00:00.000Z',
    })),
  } as never;
}

describe('MobileSyncController.sync (ADR-0150/ADR-0157)', () => {
  it('verifies each distinct employeeId in the batch before syncing', async () => {
    const { controller, mobileSync, employeeSession } = buildController();

    await controller.sync(buildDto([EMPLOYEE_ID, EMPLOYEE_ID]), buildRequest());

    expect(employeeSession.assertEmployeeIdMatchesSession).toHaveBeenCalledTimes(1);
    expect(mobileSync.syncBatch).toHaveBeenCalled();
  });

  it('rejects a batch mixing in another employee id if the session check fails', async () => {
    const { controller, mobileSync, employeeSession } = buildController();
    employeeSession.assertEmployeeIdMatchesSession = jest.fn().mockRejectedValue(new ForbiddenException('mismatch'));

    await expect(controller.sync(buildDto([EMPLOYEE_ID, OTHER_EMPLOYEE_ID]), buildRequest())).rejects.toThrow(
      ForbiddenException,
    );
    expect(mobileSync.syncBatch).not.toHaveBeenCalled();
  });

  it('rejects when the request has no token claims at all', async () => {
    const { controller, mobileSync } = buildController();

    await expect(controller.sync(buildDto([EMPLOYEE_ID]), buildRequestWithNoClaims())).rejects.toThrow(
      ForbiddenException,
    );
    expect(mobileSync.syncBatch).not.toHaveBeenCalled();
  });
});
