import { ForbiddenException, Injectable } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/access-token.guard';
import { EmployeeGrpcClientService } from './employee-grpc-client.service';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * ADR-0150/ADR-0157, closing Module 11's Gap 3 for this service. Until now
 * `EmployeeAttendanceRecordController`/`EmployeeLeaveBalanceController`
 * accepted the `employeeId` path param as-is - any authenticated caller
 * could ask for any other employee's attendance/leave data. Resolves the
 * JWT's `sub` claim to the real `Employee.id` it is linked to (core's
 * `GetEmployeeIdForUser` RPC) and compares it to the request's `employeeId`.
 * Own copy of mobile-ess-service's identical service.
 */
@Injectable()
export class EmployeeSessionVerificationService {
  constructor(
    private readonly employeeGrpcClient: EmployeeGrpcClientService,
    private readonly metrics: MetricsService,
  ) {}

  async assertEmployeeIdMatchesSession(claims: AccessTokenClaims, employeeId: string): Promise<void> {
    if (!claims.sub) {
      this.metrics.recordRbacDenial('forbidden_employee_mismatch');
      throw new ForbiddenException('Access token has no subject claim.');
    }
    const sessionEmployeeId = await this.employeeGrpcClient.getEmployeeIdForUser(claims.tenant_id, claims.sub);
    if (sessionEmployeeId !== employeeId) {
      this.metrics.recordRbacDenial('forbidden_employee_mismatch');
      throw new ForbiddenException('employeeId does not match the authenticated session.');
    }
  }
}
