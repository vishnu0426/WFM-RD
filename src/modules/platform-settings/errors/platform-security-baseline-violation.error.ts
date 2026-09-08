import { DomainError } from '../../../common/errors/domain-error';

/**
 * Thrown by `PlatformSecurityBaselineService.assertWithinBaseline` when a
 * tenant's security-policy write (self-service or platform_admin
 * cross-tenant, both go through `TenantSettingsService.updateSecurityPolicy`)
 * would leave the tenant below the platform-wide security baseline.
 * Aggregates every violated rule into one response rather than failing on
 * the first, so a rejected save can explain everything that needs fixing at
 * once.
 */
export class PlatformSecurityBaselineViolationError extends DomainError {
  readonly code = 'PLATFORM_SECURITY_BASELINE_VIOLATION';

  constructor(violations: string[]) {
    super('This change violates the platform-wide security baseline.', { violations });
  }
}
