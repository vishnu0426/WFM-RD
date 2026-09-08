import { Injectable } from '@nestjs/common';
import { PlatformSettingsRepository } from '../repositories/platform-settings.repository';
import { PlatformSecurityBaselineViolationError } from '../errors/platform-security-baseline-violation.error';

/**
 * Minimal shape both `UpdateSecurityPolicyDto` (the partial write) and
 * `TenantSettings` (the current row) satisfy — avoids this leaf module
 * importing `tenant-settings`'s DTO/entity types directly, which would
 * create the exact import direction (`tenant-settings` -> `platform-settings`
 * -> `tenant-settings`) this module is built to avoid. Structural typing
 * only; no runtime dependency on where the caller's types come from.
 */
export interface SecurityPolicyLike {
  passwordMinLength?: number;
  passwordRequireUppercase?: boolean;
  passwordRequireNumber?: boolean;
  passwordRequireSymbol?: boolean;
  passwordExpiryDays?: number | null;
  sessionTimeoutMinutes?: number;
  mfaRequired?: boolean;
}

@Injectable()
export class PlatformSecurityBaselineService {
  constructor(private readonly repository: PlatformSettingsRepository) {}

  /**
   * Computes the *effective* post-write value per field (`dto.field ?? current.field`
   * — same partial-update semantics `TenantSettingsService.updateSecurityPolicy`'s
   * `Object.assign` already implies) and collects every baseline violation
   * rather than failing on the first, so a rejected save can explain
   * everything that needs fixing at once. A freshly-created baseline row
   * (every floor/ceiling null, every mandatory flag false) is a no-op —
   * fail-open on absence, same convention as `SystemLimitsPolicyService`.
   */
  async assertWithinBaseline(dto: SecurityPolicyLike, current: SecurityPolicyLike): Promise<void> {
    const baseline = await this.repository.getOrCreate();
    const effective = { ...current, ...dto };
    const violations: string[] = [];

    if (baseline.passwordMinLengthFloor != null) {
      const value = effective.passwordMinLength ?? 0;
      if (value < baseline.passwordMinLengthFloor) {
        violations.push(`Password minimum length must be at least ${baseline.passwordMinLengthFloor} (platform baseline).`);
      }
    }
    if (baseline.passwordRequireUppercase && !effective.passwordRequireUppercase) {
      violations.push('Passwords must require an uppercase letter (platform baseline).');
    }
    if (baseline.passwordRequireNumber && !effective.passwordRequireNumber) {
      violations.push('Passwords must require a number (platform baseline).');
    }
    if (baseline.passwordRequireSymbol && !effective.passwordRequireSymbol) {
      violations.push('Passwords must require a symbol (platform baseline).');
    }
    if (baseline.passwordExpiryDaysCeiling != null) {
      const value = effective.passwordExpiryDays;
      // "Never expire" (null) is stricter-than-infinite, not compliant with a real ceiling.
      if (value == null || value > baseline.passwordExpiryDaysCeiling) {
        violations.push(`Password expiry must be set to at most ${baseline.passwordExpiryDaysCeiling} days (platform baseline).`);
      }
    }
    if (baseline.sessionTimeoutCeilingMinutes != null) {
      const value = effective.sessionTimeoutMinutes ?? 0;
      if (value > baseline.sessionTimeoutCeilingMinutes) {
        violations.push(`Session timeout must be at most ${baseline.sessionTimeoutCeilingMinutes} minutes (platform baseline).`);
      }
    }
    if (baseline.mfaRequired && !effective.mfaRequired) {
      violations.push('MFA must be required (platform baseline).');
    }

    if (violations.length > 0) {
      throw new PlatformSecurityBaselineViolationError(violations);
    }
  }
}
