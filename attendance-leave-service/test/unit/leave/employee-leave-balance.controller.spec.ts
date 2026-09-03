import { ForbiddenException } from '@nestjs/common';
import { EmployeeLeaveBalanceController } from '../../../src/leave/employee-leave-balance.controller';
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
  const listService = { listCurrentForEmployee: jest.fn().mockResolvedValue([]) };
  const provisionService = { provision: jest.fn().mockResolvedValue({}) };
  const tenantContext = { requireTenantId: jest.fn().mockReturnValue(TENANT_ID) };
  const employeeSession = { assertEmployeeIdMatchesSession: jest.fn().mockResolvedValue(undefined) };
  const controller = new EmployeeLeaveBalanceController(
    listService as never,
    provisionService as never,
    tenantContext as never,
    employeeSession as never,
  );
  return { controller, listService, provisionService, employeeSession };
}

describe('EmployeeLeaveBalanceController.listBalances (ADR-0150/ADR-0157)', () => {
  it('verifies the employeeId against the session before listing balances', async () => {
    const { controller, listService, employeeSession } = buildController();

    await controller.listBalances(EMPLOYEE_ID, buildRequest());

    expect(employeeSession.assertEmployeeIdMatchesSession).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-1' }),
      EMPLOYEE_ID,
    );
    expect(listService.listCurrentForEmployee).toHaveBeenCalled();
  });

  it('rejects when the employeeId does not match the session', async () => {
    const { controller, listService, employeeSession } = buildController();
    employeeSession.assertEmployeeIdMatchesSession = jest.fn().mockRejectedValue(new ForbiddenException('mismatch'));

    await expect(controller.listBalances(EMPLOYEE_ID, buildRequest())).rejects.toThrow(ForbiddenException);
    expect(listService.listCurrentForEmployee).not.toHaveBeenCalled();
  });

  it('rejects when the request has no token claims at all', async () => {
    const { controller, listService } = buildController();

    await expect(controller.listBalances(EMPLOYEE_ID, buildRequestWithNoClaims())).rejects.toThrow(ForbiddenException);
    expect(listService.listCurrentForEmployee).not.toHaveBeenCalled();
  });

  describe('manager access (Attendance & Leave Manager Views phase)', () => {
    const MANAGER_CLAIMS = { tenant_id: TENANT_ID, permissions: ['leave_request:read'], sub: 'manager-1' };

    it('skips the session-match check for a caller holding leave_request:read', async () => {
      const { controller, listService, employeeSession } = buildController();

      await controller.listBalances(EMPLOYEE_ID, buildRequest(MANAGER_CLAIMS));

      expect(employeeSession.assertEmployeeIdMatchesSession).not.toHaveBeenCalled();
      expect(listService.listCurrentForEmployee).toHaveBeenCalledWith(TENANT_ID, EMPLOYEE_ID);
    });

    it('still enforces the session-match check for a caller without leave_request:read', async () => {
      const { controller, employeeSession } = buildController();

      await controller.listBalances(EMPLOYEE_ID, buildRequest());

      expect(employeeSession.assertEmployeeIdMatchesSession).toHaveBeenCalled();
    });
  });
});

describe('EmployeeLeaveBalanceController.provisionBalance', () => {
  const LEAVE_TYPE_ID = '33333333-3333-4333-8333-333333333333';
  const dto = { leaveTypeId: LEAVE_TYPE_ID, periodStart: '2026-01-01', periodEnd: '2026-12-31', accruedDays: 20 };

  it('delegates to ProvisionLeaveBalanceService with the resolved tenant and path employeeId', async () => {
    const { controller, provisionService } = buildController();

    await controller.provisionBalance(EMPLOYEE_ID, dto);

    expect(provisionService.provision).toHaveBeenCalledWith(TENANT_ID, EMPLOYEE_ID, dto);
  });
});
