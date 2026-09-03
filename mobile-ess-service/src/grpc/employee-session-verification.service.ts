import { ForbiddenException, Injectable } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/access-token.guard';
import { EmployeeGrpcClientService } from './employee-grpc-client.service';

/**
 * ADR-0150/ADR-0157, closing Module 11's Gap 3. Until now every endpoint
 * that takes a client-supplied `employeeId` (`mobile-sync`, `devices`,
 * `geofence-config`) accepted it as-is - any authenticated caller could ask
 * for/act on any other employee's data. Resolves the JWT's `sub` claim to
 * the real `Employee.id` it is linked to (root platform-core's
 * `GetEmployeeIdForUser` RPC) and compares it to the request's `employeeId`.
 */
@Injectable()
export class EmployeeSessionVerificationService {
  constructor(private readonly employeeGrpcClient: EmployeeGrpcClientService) {}

  async assertEmployeeIdMatchesSession(claims: AccessTokenClaims, employeeId: string): Promise<void> {
    if (!claims.sub) {
      throw new ForbiddenException('Access token has no subject claim.');
    }
    const sessionEmployeeId = await this.employeeGrpcClient.getEmployeeIdForUser(claims.tenant_id, claims.sub);
    if (sessionEmployeeId !== employeeId) {
      throw new ForbiddenException('employeeId does not match the authenticated session.');
    }
  }
}
