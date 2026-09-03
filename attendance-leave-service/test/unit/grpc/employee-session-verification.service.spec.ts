import { ForbiddenException } from '@nestjs/common';
import { EmployeeSessionVerificationService } from '../../../src/grpc/employee-session-verification.service';
import { AccessTokenClaims } from '../../../src/auth/access-token.guard';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const EMPLOYEE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_EMPLOYEE_ID = '44444444-4444-4444-8444-444444444444';

function buildClaims(overrides: Partial<AccessTokenClaims> = {}): AccessTokenClaims {
  return { tenant_id: TENANT_ID, permissions: [], sub: USER_ID, ...overrides } as AccessTokenClaims;
}

describe('EmployeeSessionVerificationService (ADR-0150/ADR-0157)', () => {
  function buildService(sessionEmployeeId: string | null) {
    const employeeGrpcClient = { getEmployeeIdForUser: jest.fn().mockResolvedValue(sessionEmployeeId) };
    const metrics = { recordRbacDenial: jest.fn() };
    const service = new EmployeeSessionVerificationService(employeeGrpcClient as never, metrics as never);
    return { service, employeeGrpcClient, metrics };
  }

  it('resolves the sub claim to an employeeId and allows a match', async () => {
    const { service, employeeGrpcClient } = buildService(EMPLOYEE_ID);

    await expect(service.assertEmployeeIdMatchesSession(buildClaims(), EMPLOYEE_ID)).resolves.toBeUndefined();
    expect(employeeGrpcClient.getEmployeeIdForUser).toHaveBeenCalledWith(TENANT_ID, USER_ID);
  });

  it('throws ForbiddenException and records a denial when the requested employeeId does not match the session', async () => {
    const { service, metrics } = buildService(EMPLOYEE_ID);

    await expect(service.assertEmployeeIdMatchesSession(buildClaims(), OTHER_EMPLOYEE_ID)).rejects.toThrow(
      ForbiddenException,
    );
    expect(metrics.recordRbacDenial).toHaveBeenCalledWith('forbidden_employee_mismatch');
  });

  it('throws ForbiddenException when the session has no linked employee at all', async () => {
    const { service } = buildService(null);

    await expect(service.assertEmployeeIdMatchesSession(buildClaims(), EMPLOYEE_ID)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('throws ForbiddenException when the token has no sub claim, without calling the RPC', async () => {
    const { service, employeeGrpcClient } = buildService(EMPLOYEE_ID);

    await expect(service.assertEmployeeIdMatchesSession(buildClaims({ sub: undefined }), EMPLOYEE_ID)).rejects.toThrow(
      ForbiddenException,
    );
    expect(employeeGrpcClient.getEmployeeIdForUser).not.toHaveBeenCalled();
  });
});
