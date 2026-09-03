import { Injectable } from '@nestjs/common';
import { PoliciesRepository } from '../../policy/repositories/policies.repository';
import { PolicyType } from '../../policy/entities/policy-type.enum';
import { UnauthorizedClientError } from '../errors/unauthorized-client.error';

export type AuthMethod = 'pwd' | 'webauthn';

interface AuthMethodPolicyDefinition {
  requiredMethods?: AuthMethod[];
  allowedMethods?: AuthMethod[];
}

const DEFAULT_ALLOWED: AuthMethod[] = ['pwd', 'webauthn'];

/**
 * §5.4: "per-tenant policy on which methods are required vs optional,"
 * reusing Phase 1's JSONB `Policy.definition` mechanism (ADR-0003) via the
 * new `auth_method_policy` `PolicyType` rather than a dedicated table - the
 * whole point of that mechanism (§2.1 rule 4) is exactly this: a new
 * policy-governed concern that doesn't need its own schema.
 *
 * No tenant policy row means both methods are allowed and neither is
 * required (Phase 2's original behavior - password-only, unchanged for a
 * tenant that never configures this).
 */
@Injectable()
export class AuthMethodPolicyService {
  constructor(private readonly policiesRepository: PoliciesRepository) {}

  async getPolicy(): Promise<Required<AuthMethodPolicyDefinition>> {
    const policy = await this.policiesRepository.findActiveByType(PolicyType.AUTH_METHOD_POLICY, new Date());
    if (!policy) {
      return { requiredMethods: [], allowedMethods: DEFAULT_ALLOWED };
    }
    const definition = policy.definition as AuthMethodPolicyDefinition;
    return {
      requiredMethods: definition.requiredMethods ?? [],
      allowedMethods: definition.allowedMethods ?? DEFAULT_ALLOWED,
    };
  }

  /**
   * Throws if `method` isn't in `allowedMethods`, or if `requiredMethods` is
   * non-empty and doesn't include `method` (a tenant that requires
   * `webauthn` rejects a `pwd` login attempt outright, even though `pwd`
   * might otherwise be in `allowedMethods` for other tenants' defaults).
   */
  async assertMethodPermitted(method: AuthMethod): Promise<void> {
    const { requiredMethods, allowedMethods } = await this.getPolicy();
    if (!allowedMethods.includes(method)) {
      throw new UnauthorizedClientError(`Authentication method "${method}" is not permitted for this tenant.`);
    }
    if (requiredMethods.length > 0 && !requiredMethods.includes(method)) {
      throw new UnauthorizedClientError(
        `This tenant requires one of [${requiredMethods.join(', ')}] - "${method}" was presented instead.`,
      );
    }
  }
}
