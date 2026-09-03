import { Injectable } from '@nestjs/common';
import { PoliciesRepository } from '../repositories/policies.repository';
import { PolicyType } from '../entities/policy-type.enum';
import { SystemLimitExceededError } from '../errors/system-limit-exceeded.error';

interface SystemLimitsDefinition {
  maxUsers?: number;
  maxEmployees?: number;
  maxOrgUnits?: number;
}

/**
 * System Configuration's "System Limits" setting — distinct from a PLAN
 * LIMIT (no plan/entitlement system exists in this codebase) and from
 * ordinary DTO field-length validation. Same generic Policy mechanism as
 * `AuthMethodPolicyService`/`AccessRestrictionPolicyService`: no policy row
 * = no limit (fail-open on absence).
 *
 * Enforced at the specific, real creation choke points this session's audit
 * found (`EmployeesService.create`, `OrgUnitsService.create`, and the
 * everyday `POST /v1/users/invite` path for users) — a best-effort
 * application-level control, not a database constraint. User creation has
 * three other, rarer entry points (platform-admin `provision-admin`, SSO
 * JIT provisioning, SCIM) this round doesn't also gate — disclosed as a
 * known gap rather than silently claimed watertight.
 */
@Injectable()
export class SystemLimitsPolicyService {
  constructor(private readonly policiesRepository: PoliciesRepository) {}

  async getLimits(): Promise<SystemLimitsDefinition> {
    const policy = await this.policiesRepository.findActiveByType(PolicyType.SYSTEM_LIMITS, new Date());
    return (policy?.definition as SystemLimitsDefinition) ?? {};
  }

  async assertWithinLimit(kind: 'maxUsers' | 'maxEmployees' | 'maxOrgUnits', currentCount: number): Promise<void> {
    const limits = await this.getLimits();
    const limit = limits[kind];
    if (limit != null && currentCount >= limit) {
      throw new SystemLimitExceededError(kind, limit);
    }
  }
}
