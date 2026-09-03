import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { PoliciesRepository } from '../../modules/policy/repositories/policies.repository';
import { Policy } from '../../modules/policy/entities/policy.entity';
import { PolicyType } from '../../modules/policy/entities/policy-type.enum';

interface GetActivePolicyRequest {
  tenantId: string;
  policyGroupId: string;
  policyType: string;
  orgUnitId: string;
  asOf: string;
}

interface PolicyResponse {
  found: boolean;
  id: string;
  policyGroupId: string;
  policyType: string;
  orgUnitId: string;
  definitionJson: string;
  effectiveFrom: string;
  effectiveTo: string;
  version: number;
}

const NOT_FOUND: PolicyResponse = {
  found: false,
  id: '',
  policyGroupId: '',
  policyType: '',
  orgUnitId: '',
  definitionJson: '',
  effectiveFrom: '',
  effectiveTo: '',
  version: 0,
};

/**
 * §3.3's `PolicyService`. Tenant context has no HTTP middleware to bind it
 * here (ADR-0021) - bound explicitly from the request message's own
 * `tenant_id`, same posture as `EmployeeGrpcController`/`IdentityGrpcController`.
 */
@Controller()
export class PolicyGrpcController {
  private readonly logger = new Logger(PolicyGrpcController.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly policiesRepository: PoliciesRepository,
  ) {}

  @GrpcMethod('PolicyService', 'GetActivePolicy')
  async getActivePolicy(request: GetActivePolicyRequest): Promise<PolicyResponse> {
    return this.tenantContext.run({ tenantId: request.tenantId }, async () => {
      const asOf = request.asOf ? new Date(request.asOf) : new Date();

      let policy: Policy | null;
      if (request.policyGroupId) {
        policy = await this.policiesRepository.findActiveAsOf(request.policyGroupId, asOf);
      } else if (request.policyType) {
        policy = await this.policiesRepository.findActiveByTypeAndScope(
          request.policyType as PolicyType,
          request.orgUnitId || null,
          asOf,
        );
      } else {
        this.logger.warn(
          `GetActivePolicy called with neither policy_group_id nor policy_type (tenant=${request.tenantId})`,
        );
        return NOT_FOUND;
      }

      if (!policy) {
        return NOT_FOUND;
      }
      return {
        found: true,
        id: policy.id,
        policyGroupId: policy.policyGroupId,
        policyType: policy.policyType,
        orgUnitId: policy.orgUnitId ?? '',
        definitionJson: JSON.stringify(policy.definition),
        effectiveFrom: policy.effectiveFrom.toISOString(),
        effectiveTo: policy.effectiveTo?.toISOString() ?? '',
        version: policy.version,
      };
    });
  }
}
