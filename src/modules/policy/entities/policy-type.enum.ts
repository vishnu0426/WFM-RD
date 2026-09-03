export enum PolicyType {
  OVERTIME_RULE = 'overtime_rule',
  BREAK_RULE = 'break_rule',
  APPROVAL_CHAIN = 'approval_chain',
  DATA_RETENTION = 'data_retention',
  /** Backs the Envoy per-tenant rate-limit config described in §3.4. */
  RATE_LIMIT = 'rate_limit',
  /**
   * Module 02 §2.1 `EmploymentPolicy.policy_type` values (ADR-0012) - added
   * here rather than a parallel policy table so `PolicyService.GetActivePolicy`
   * serves both modules through one query path. These four are org-unit
   * scoped via `Policy.orgUnitId`; the five above remain tenant-wide.
   */
  OVERTIME_THRESHOLD = 'overtime_threshold',
  REST_PERIOD_MINIMUM = 'rest_period_minimum',
  MAX_CONSECUTIVE_DAYS = 'max_consecutive_days',
  UNION_RULE = 'union_rule',
  /**
   * §5's nightly decay job (ADR-0017): `definition.halfLifeDays` for the
   * `decay_score = exp(-ln(2)/halfLifeDays * daysSinceLastScheduled)`
   * formula. Tenant-wide only (`orgUnitId` left null) - §5 says
   * "tenant-configurable half-life," not org-unit-scoped.
   */
  SKILL_DECAY_HALF_LIFE = 'skill_decay_half_life',
  /**
   * Module 01 Phase 3 (§5.4): "per-tenant policy on which methods are
   * required vs optional." `definition` shape:
   * `{ requiredMethods: ('pwd'|'webauthn')[], allowedMethods: (...)[] }` -
   * see `AuthMethodPolicyService`. Tenant-wide only.
   */
  AUTH_METHOD_POLICY = 'auth_method_policy',
  /**
   * Module 11 Phase 6 (§5b, docs/adr/0155): org-unit-scoped only
   * (`Policy.orgUnitId` required by convention, same as the four
   * `EmploymentPolicy` types above - the schema itself allows null for any
   * type). No row for a given org unit = geofencing inactive there - this
   * IS the tenant opt-in mechanism (default off; a tenant must create a
   * row per org unit to activate it, and there is deliberately no separate
   * tenant-level kill switch - ADR-0155). `definition` shape:
   * `{ centerLatitude: number, centerLongitude: number, radiusMeters: number,
   * enforcement: 'soft' | 'hard' }` - not schema-enforced, same convention
   * as every other `PolicyType`'s documented-not-validated shape. Consumed
   * by mobile-ess-service's `GeofenceVerificationService` via the existing
   * `PolicyService.GetActivePolicy` gRPC - the first cross-service
   * consumer of that RPC.
   */
  GEOFENCE_BOUNDARY = 'geofence_boundary',
  /**
   * System Configuration gap-fix: login-time IP allowlist / allowed email
   * domains. `definition` shape: `{ ipAllowlist?: string[] (CIDR or bare
   * IP), allowedEmailDomains?: string[] }`. Tenant-wide only. No policy row
   * = no restriction (fail-open on absence, same posture as
   * AUTH_METHOD_POLICY — a tenant that never configures this is unaffected).
   * Consumed by `AccessRestrictionPolicyService`, enforced in
   * `OAuthController.authorize` before either credential path runs.
   */
  ACCESS_RESTRICTION_POLICY = 'access_restriction_policy',
  /**
   * System Configuration gap-fix: per-tenant SYSTEM LIMIT (distinct from a
   * PLAN LIMIT — there is no plan/entitlement system in this codebase — and
   * distinct from ordinary DTO-level field validation). `definition` shape:
   * `{ maxUsers?: number, maxEmployees?: number, maxOrgUnits?: number }`.
   * No policy row = no limit. Consumed by `SystemLimitsPolicyService`,
   * enforced immediately before the relevant repository's `.save()` call.
   */
  SYSTEM_LIMITS = 'system_limits',
  /**
   * System Configuration gap-fix: tenant-scoped read-only/maintenance mode.
   * `definition` shape: `{ enabled: boolean, message?: string }`. No policy
   * row = not in maintenance. Consumed by `MaintenanceModeMiddleware`,
   * rejects non-GET requests for this tenant with 503 unless the caller is
   * platform_admin (an emergency escape hatch, same posture as every other
   * platform_admin bypass in this codebase).
   */
  MAINTENANCE_MODE = 'maintenance_mode',
}
