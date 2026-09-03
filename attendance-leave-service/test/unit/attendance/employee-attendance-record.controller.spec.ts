import { ForbiddenException } from '@nestjs/common';
import { EmployeeAttendanceRecordController } from '../../../src/attendance/employee-attendance-record.controller';
import { RequestWithTokenClaims } from '../../../src/auth/access-token.guard';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE_ID = '22222222-2222-4222-8222-222222222222';

const AUTHENTICATED_CLAIMS = { tenant_id: TENANT_ID, permissions: [], sub: 'user-1' };

function buildRequest(claims: unknown = AUTHENTICATED_CLAIMS) {
  return { tokenClaims: claims } as RequestWithTokenClaims;
}

function buildRequestWithNoClaims(): RequestWithTokenClaims {
  return {} as RequestWithTokenClaims;
}

function buildController() {
  const listService = { listForEmployee: jest.fn().mockResolvedValue([]) };
  const tenantContext = { requireTenantId: jest.fn().mockReturnValue(TENANT_ID) };
  const employeeSession = { assertEmployeeIdMatchesSession: jest.fn().mockResolvedValue(undefined) };
  const controller = new EmployeeAttendanceRecordController(
    listService as never,
    tenantContext as never,
    employeeSession as never,
  );
  return { controller, listService, employeeSession };
}

const QUERY = { from: '2026-01-01', to: '2026-01-31' } as never;

describe('EmployeeAttendanceRecordController.listRecords (ADR-0150/ADR-0157)', () => {
  it('verifies the employeeId against the session before listing records', async () => {
    const { controller, listService, employeeSession } = buildController();

    await controller.listRecords(EMPLOYEE_ID, QUERY, buildRequest());

    expect(employeeSession.assertEmployeeIdMatchesSession).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-1' }),
      EMPLOYEE_ID,
    );
    expect(listService.listForEmployee).toHaveBeenCalled();
  });

  it('rejects when the employeeId does not match the session', async () => {
    const { controller, listService, employeeSession } = buildController();
    employeeSession.assertEmployeeIdMatchesSession = jest.fn().mockRejectedValue(new ForbiddenException('mismatch'));

    await expect(controller.listRecords(EMPLOYEE_ID, QUERY, buildRequest())).rejects.toThrow(ForbiddenException);
    expect(listService.listForEmployee).not.toHaveBeenCalled();
  });

  it('rejects when the request has no token claims at all', async () => {
    const { controller, listService } = buildController();

    await expect(controller.listRecords(EMPLOYEE_ID, QUERY, buildRequestWithNoClaims())).rejects.toThrow(
      ForbiddenException,
    );
    expect(listService.listForEmployee).not.toHaveBeenCalled();
  });
});
