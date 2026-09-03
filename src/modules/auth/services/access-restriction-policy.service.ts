import { Injectable } from '@nestjs/common';
import { PoliciesRepository } from '../../policy/repositories/policies.repository';
import { PolicyType } from '../../policy/entities/policy-type.enum';
import { UnauthorizedClientError } from '../errors/unauthorized-client.error';

interface AccessRestrictionPolicyDefinition {
  ipAllowlist?: string[];
  allowedEmailDomains?: string[];
}

/**
 * System Configuration's "Access Restrictions" setting — same shape as
 * `AuthMethodPolicyService` (generic `Policy`/`PolicyType.ACCESS_RESTRICTION_POLICY`
 * mechanism, fail-open when no tenant row exists). IP matching is
 * deliberately simple and honest about it: an allowlist entry is either a
 * bare IP (exact match) or an octet-prefix ending in "." (e.g. "10.0." —
 * whole-octet startsWith, not real CIDR/subnet-mask arithmetic). No CIDR
 * ("/24") notation is accepted — this platform has no CIDR library, and
 * silently mis-parsing a "/23"-style non-octet-boundary mask would be a
 * worse outcome than a deliberately narrower, correctly-documented feature.
 */
@Injectable()
export class AccessRestrictionPolicyService {
  constructor(private readonly policiesRepository: PoliciesRepository) {}

  async getPolicy(): Promise<AccessRestrictionPolicyDefinition> {
    const policy = await this.policiesRepository.findActiveByType(PolicyType.ACCESS_RESTRICTION_POLICY, new Date());
    return (policy?.definition as AccessRestrictionPolicyDefinition) ?? {};
  }

  async assertLoginPermitted(input: { ip: string | undefined; email: string }): Promise<void> {
    const { ipAllowlist, allowedEmailDomains } = await this.getPolicy();

    if (ipAllowlist && ipAllowlist.length > 0) {
      const ip = input.ip ?? '';
      const permitted = ipAllowlist.some((entry) => this.matchesIp(ip, entry));
      if (!permitted) {
        throw new UnauthorizedClientError(`Login is not permitted from this network (${ip || 'unknown IP'}).`);
      }
    }

    if (allowedEmailDomains && allowedEmailDomains.length > 0) {
      const domain = input.email.split('@')[1]?.toLowerCase();
      const permitted = !!domain && allowedEmailDomains.some((d) => d.toLowerCase() === domain);
      if (!permitted) {
        throw new UnauthorizedClientError(`Login is not permitted for this email domain (${domain ?? 'unknown'}).`);
      }
    }
  }

  private matchesIp(ip: string, entry: string): boolean {
    if (entry.endsWith('.')) {
      return ip.startsWith(entry);
    }
    return ip === entry;
  }
}
