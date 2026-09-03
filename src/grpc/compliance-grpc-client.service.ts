import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable, timeout } from 'rxjs';
import { COMPLIANCE_GRPC_PACKAGE } from './compliance-grpc-client.constants';
import { DomainError } from '../common/errors/domain-error';

export interface ValidatePolicyAgainstFloorRequest {
  tenantId: string;
  jurisdiction: string;
  ruleType: string;
  policyDefinitionJson: string;
}

export interface ValidatePolicyAgainstFloorResponse {
  valid: boolean;
  violations: string[];
  floorNotFound: boolean;
}

interface ComplianceRuleServiceClient {
  validatePolicyAgainstFloor(
    request: ValidatePolicyAgainstFloorRequest,
  ): Observable<ValidatePolicyAgainstFloorResponse>;
}

const CALL_TIMEOUT_MS = 3000;

/**
 * Module 08 Phase 8 (docs/adr/0107): was a bare `Error` subclass since
 * ADR-0101 first introduced it - every prior phase's checklist flagged
 * this as a disclosed "surfaces as a generic 500, not a clean typed error
 * code" polish gap, never fixed until now. `EmploymentPoliciesService.create`
 * never catches this specially (fail-closed means it should propagate),
 * so making it a real `DomainError` only changes its *shape* at the REST/
 * GraphQL boundary, not the fail-closed behavior itself.
 */
export class ComplianceGrpcClientUnavailableError extends DomainError {
  readonly code = 'COMPLIANCE_SERVICE_UNAVAILABLE';

  constructor(cause: unknown) {
    super(`ComplianceRuleService.ValidatePolicyAgainstFloor unavailable: ${(cause as Error).message}`);
  }
}

/**
 * §0.6/ADR-0101: root's first outbound gRPC client - calls Module 08's
 * `ComplianceRuleService.ValidatePolicyAgainstFloor` (adherence-compliance-service/,
 * `agno.compliance.v1`), the write-time gate `EmploymentPoliciesService.create`
 * calls before every write. Own copy of every other service's identical
 * client shape (e.g. shift-marketplace-service's `EmployeeGrpcClientService`),
 * just now living in root rather than a downstream consumer - this is the
 * first time root itself has needed to call *out* to another service
 * rather than only ever being called.
 */
@Injectable()
export class ComplianceGrpcClientService implements OnModuleInit {
  private client!: ComplianceRuleServiceClient;

  constructor(@Inject(COMPLIANCE_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<ComplianceRuleServiceClient>('ComplianceRuleService');
  }

  async validatePolicyAgainstFloor(
    request: ValidatePolicyAgainstFloorRequest,
  ): Promise<ValidatePolicyAgainstFloorResponse> {
    try {
      return await firstValueFrom(this.client.validatePolicyAgainstFloor(request).pipe(timeout(CALL_TIMEOUT_MS)));
    } catch (err) {
      throw new ComplianceGrpcClientUnavailableError(err);
    }
  }
}
