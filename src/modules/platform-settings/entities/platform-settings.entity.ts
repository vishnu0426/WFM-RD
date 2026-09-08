import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Platform Settings gap-fix: a genuinely platform-wide (not per-tenant)
 * singleton row — SMTP fallback config + security-policy baseline. Same
 * "no tenant_id, no RLS" posture as `Permission`/`SigningKey` (the only
 * other global-reference-data entities in this codebase), NOT a
 * `TenantScopedRepository`-backed table like `TenantSettings`. Since there
 * is no `tenant_id` to build a uniqueness guarantee on, the singleton is
 * enforced by always reading/writing the one fixed `id` in
 * `PLATFORM_SETTINGS_SINGLETON_ID` rather than "find any row."
 */
export const PLATFORM_SETTINGS_SINGLETON_ID = '00000000-0000-0000-0000-000000000001';

@Entity({ schema: 'core', name: 'platform_settings' })
export class PlatformSettings {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  // --- SMTP fallback (used only when a tenant has no smtpHost of its own —
  // see SmtpChannelAdapter.send()) ---
  @Column({ type: 'varchar', length: 255, name: 'smtp_host', nullable: true })
  smtpHost!: string | null;

  @Column({ type: 'integer', name: 'smtp_port', nullable: true })
  smtpPort!: number | null;

  @Column({ type: 'varchar', length: 255, name: 'smtp_username', nullable: true })
  smtpUsername!: string | null;

  @Column({ type: 'text', name: 'smtp_password', nullable: true })
  smtpPassword!: string | null;

  @Column({ type: 'varchar', length: 255, name: 'smtp_from_address', nullable: true })
  smtpFromAddress!: string | null;

  @Column({ type: 'boolean', name: 'smtp_use_tls', default: true })
  smtpUseTls!: boolean;

  // --- Security baseline — floors/ceilings every tenant's own security
  // policy (TenantSettings) must respect, enforced in
  // TenantSettingsService.updateSecurityPolicy via
  // PlatformSecurityBaselineService. Null/false = no restriction (fail-open
  // on absence, same convention as SystemLimitsPolicyService). ---
  @Column({ type: 'integer', name: 'password_min_length_floor', nullable: true })
  passwordMinLengthFloor!: number | null;

  @Column({ type: 'boolean', name: 'password_require_uppercase', default: false })
  passwordRequireUppercase!: boolean;

  @Column({ type: 'boolean', name: 'password_require_number', default: false })
  passwordRequireNumber!: boolean;

  @Column({ type: 'boolean', name: 'password_require_symbol', default: false })
  passwordRequireSymbol!: boolean;

  @Column({ type: 'integer', name: 'password_expiry_days_ceiling', nullable: true })
  passwordExpiryDaysCeiling!: number | null;

  @Column({ type: 'integer', name: 'session_timeout_ceiling_minutes', nullable: true })
  sessionTimeoutCeilingMinutes!: number | null;

  @Column({ type: 'boolean', name: 'mfa_required', default: false })
  mfaRequired!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
