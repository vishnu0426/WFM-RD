import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * One row per tenant (`tenant_id` UNIQUE) — outbound-email/SMTP config,
 * security policy, and general/branding settings. `smtpPassword` in a
 * plaintext column is the same explicit trade-off already accepted for
 * `TenantIdentityProvider.oidcClientSecret` (this app has no Vault client;
 * only `integration-hub-service` does) — never returned from any API
 * response, see `TenantSettingsView`.
 */
@Entity({ schema: 'core', name: 'tenant_settings' })
@Index('idx_tenant_settings_tenant_id', ['tenantId'], { unique: true })
export class TenantSettings {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  // --- Email / SMTP ---
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

  // --- Security policy ---
  @Column({ type: 'integer', name: 'password_min_length', default: 12 })
  passwordMinLength!: number;

  @Column({ type: 'boolean', name: 'password_require_uppercase', default: true })
  passwordRequireUppercase!: boolean;

  @Column({ type: 'boolean', name: 'password_require_number', default: true })
  passwordRequireNumber!: boolean;

  @Column({ type: 'boolean', name: 'password_require_symbol', default: false })
  passwordRequireSymbol!: boolean;

  /** Null = passwords never expire. */
  @Column({ type: 'integer', name: 'password_expiry_days', nullable: true })
  passwordExpiryDays!: number | null;

  @Column({ type: 'integer', name: 'session_timeout_minutes', default: 60 })
  sessionTimeoutMinutes!: number;

  @Column({ type: 'boolean', name: 'mfa_required', default: false })
  mfaRequired!: boolean;

  // --- General ---
  @Column({ type: 'varchar', length: 500, name: 'brand_logo_url', nullable: true })
  brandLogoUrl!: string | null;

  @Column({ type: 'varchar', length: 100, default: 'UTC' })
  timezone!: string;

  @Column({ type: 'varchar', length: 20, default: 'en-US' })
  locale!: string;

  @Column({ type: 'integer', name: 'data_retention_days', default: 365 })
  dataRetentionDays!: number;

  /** Ordered `SelfIdentificationProperty` keys — see that enum's own doc comment. */
  @Column({ type: 'jsonb', name: 'self_identification_properties', default: () => "'[]'" })
  selfIdentificationProperties!: string[];

  // --- WFM defaults (Platform Admin onboarding's "WFM Configuration" step) ---
  /** e.g. 'monday' - free text, no enum, same posture as `timezone` above. */
  @Column({ type: 'varchar', length: 10, name: 'week_start_day', nullable: true })
  weekStartDay!: string | null;

  /** The clock time a WFM "day" resets at, for shifts crossing midnight. */
  @Column({ type: 'time', name: 'day_boundary', nullable: true })
  dayBoundary!: string | null;

  // --- Workforce defaults (System Configuration gap-fix) — real, validated,
  // persisted, but NOT YET consumed by scheduling-service/forecasting-service/
  // attendance-leave-service (see the adding migration's own doc comment for
  // exactly why: deliberate schema-isolation ADRs block direct DB access,
  // and no gRPC RPC exposes this table to those services yet). Disclosed as
  // BACKEND GAP in the System Configuration UI, not implied to be live. ---
  @Column({ type: 'integer', name: 'scheduling_interval_minutes', nullable: true })
  schedulingIntervalMinutes!: number | null;

  @Column({ type: 'integer', name: 'planning_period_weeks', nullable: true })
  planningPeriodWeeks!: number | null;

  @Column({ type: 'numeric', precision: 4, scale: 2, name: 'default_shift_duration_hours', nullable: true })
  defaultShiftDurationHours!: string | null;

  @Column({ type: 'integer', name: 'forecasting_interval_minutes', nullable: true })
  forecastingIntervalMinutes!: number | null;

  @Column({ type: 'integer', name: 'historical_data_window_weeks', nullable: true })
  historicalDataWindowWeeks!: number | null;

  @Column({ type: 'integer', name: 'forecasting_planning_horizon_weeks', nullable: true })
  forecastingPlanningHorizonWeeks!: number | null;

  @Column({ type: 'integer', name: 'attendance_grace_period_minutes', nullable: true })
  attendanceGracePeriodMinutes!: number | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
