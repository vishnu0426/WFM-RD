import 'reflect-metadata';
import { v4 as uuidv4 } from 'uuid';
import { IsNull } from 'typeorm';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { AppDataSource } from '../data-source';
import { Tenant } from '../../modules/tenant/entities/tenant.entity';
import { TenantTier } from '../../modules/tenant/entities/tenant-tier.enum';
import { TenantStatus } from '../../modules/tenant/entities/tenant-status.enum';
import { User } from '../../modules/identity/entities/user.entity';
import { UserStatus } from '../../modules/identity/entities/user-status.enum';
import { Role } from '../../modules/identity/entities/role.entity';
import { Permission } from '../../modules/identity/entities/permission.entity';
import { PermissionAction } from '../../modules/identity/entities/permission-action.enum';
import { RolePermission } from '../../modules/identity/entities/role-permission.entity';
import { UserRole } from '../../modules/identity/entities/user-role.entity';
import { Policy } from '../../modules/policy/entities/policy.entity';
import { PolicyType } from '../../modules/policy/entities/policy-type.enum';
import { AuditLog } from '../../modules/audit/entities/audit-log.entity';
import { AuditActorType } from '../../modules/audit/entities/audit-actor-type.enum';
import { NotificationPreference } from '../../modules/notification/entities/notification-preference.entity';
import { NotificationChannel } from '../../modules/notification/entities/notification-channel.enum';
import { OrgUnit } from '../../modules/org-unit/entities/org-unit.entity';
import { OrgUnitType } from '../../modules/org-unit/entities/org-unit-type.enum';
import { OrgUnitStatus } from '../../modules/org-unit/entities/org-unit-status.enum';
import { Employee } from '../../modules/employee/entities/employee.entity';
import { EmploymentType } from '../../modules/employee/entities/employment-type.enum';
import { EmployeeStatus } from '../../modules/employee/entities/employee-status.enum';
import { Skill } from '../../modules/skill/entities/skill.entity';
import { EmployeeSkill } from '../../modules/skill/entities/employee-skill.entity';
import { ProficiencyLevel } from '../../modules/skill/entities/proficiency-level.enum';
import { WorkingTimeCalendar } from '../../modules/calendar/entities/working-time-calendar.entity';
import { SigningKey } from '../../modules/auth/entities/signing-key.entity';
import { SigningKeyStatus } from '../../modules/auth/entities/signing-key-status.enum';
import { UserCredential } from '../../modules/auth/entities/user-credential.entity';
import { OAuthClient } from '../../modules/auth/entities/oauth-client.entity';
import { OAuthClientType } from '../../modules/auth/entities/oauth-client-type.enum';
import { OAuthGrantType } from '../../modules/auth/entities/oauth-grant-type.enum';
import { TokenEndpointAuthMethod } from '../../modules/auth/entities/token-endpoint-auth-method.enum';

/**
 * Local dev seed data only. Runs with agno_migrator credentials (see
 * ../data-source.ts) so it can write global reference data (permissions,
 * system roles with tenant_id IS NULL) that agno_app's RLS policies
 * deliberately forbid it from writing (ADR-0002). This is why seeding goes
 * through the DataSource directly rather than through
 * TenantScopedRepository/NestJS DI - this script represents a platform-admin
 * operation, not application traffic.
 */
// Phase 4 (§8): 'role' backs RBAC management (`/v1/roles`, `/v1/permissions`,
// `/v1/users/{id}/roles`) - added to the catalog, not schema-constrained
// (resource is a free varchar, ADR-0003's extensibility-by-design), so this
// is the only place a new resource needs registering. Phase 5 adds 'audit'
// for `GET /v1/audit-log`. Phase 6 adds 'webhook' for `/v1/webhooks`.
// Module 06 Phase 6 (§5.1, ADR-0079): 'backdated_leave_entry' - a new,
// granular resource distinct from 'leave_request' precisely so
// `backdated_leave_entry:approve` is its own grantable permission, not a
// side effect of holding the ordinary leave-approver permission. Every
// `PermissionAction` (read/write/approve/delete) is generated for it like
// any other resource, even though only `:approve` is checked by Phase 6's
// code today - the others exist for RBAC-management-UI consistency
// (`/v1/permissions` lists a full CRUD set per resource), matching how
// every other resource in this array works.
// Module 10 Phase 8 (docs/adr/0130): 'ai_provider_config'/'ai_governance_policy' -
// ai-layer-service is a separate deployable service with no access to this
// database's own role/permission tables, but its `AccessTokenGuard` trusts
// tokens signed by this same core service (remote JWKS,
// `WellKnownController`), so the permission strings it checks
// (`ai_provider_config:write`, `ai_governance_policy:write`) must exist
// here to be grantable at all - registering them here, not fabricating a
// separate permissions table in ai-layer-service's own schema, is what
// makes them real, assignable permissions through this platform's one
// actual RBAC-management surface (`/v1/roles`, `/v1/permissions`).
// Module 12 Phase 8 (docs/adr/0145): 'integration_connector'/
// 'webhook_subscription' - integration-hub-service is another separate
// deployable service in the same remote-JWKS-resource-server shape
// ai-layer-service already established (ADR-0130); its own
// `AccessTokenGuard` trusts tokens signed by this same core service, so
// the permission strings it checks (`integration_connector:write`,
// `webhook_subscription:write`) must exist here to be grantable at all -
// gating the two highest-credential-risk writes in that module's schema
// (a connector's Vault-referenced provider credential, a webhook
// subscription's signing secret + admin-supplied target URL).
// Module 10 Phase 9 (docs/adr/0133): 'ai_interaction'/'ai_recommendation' -
// RBAC expanded from just the two admin-config mutations to every
// operation in ai-layer-service's GraphQL schema. `ai_interaction:write`
// gates every operation that generates and persists a new `AIInteraction`
// row (`explainSchedule`/`explainForecast`/`explainReallocation`/
// `rootCauseAnalysis`/`askQuestion` - all `Query`s, not `Mutation`s, but
// each has a real LLM-cost side effect, the same FinOps-relevant write
// non-negotiable #1's own posture already treats these as). `ai_recommendation`
// uses `:read`/`:write`/`:approve` distinctly - `decideRecommendation` gets
// its own `:approve` permission (the same `backdated_leave_entry:approve`
// precedent, Module 06 Phase 6) rather than reusing `:write`, since
// approving/rejecting a recommendation is a materially different action
// from creating one.
// Module 08 Phase 8 (docs/adr/0161): 'compliance_rule'/'compliance_report' -
// adherence-compliance-service is another separate deployable service in
// the same remote-JWKS-resource-server shape ai-layer-service/
// integration-hub-service already established (ADR-0130/0145); its own
// `AccessTokenGuard` trusts tokens signed by this same core service, so the
// permission strings it checks (`compliance_rule:read`/`:write`,
// `compliance_report:read`/`:write`/`:approve`) must exist here to be
// grantable at all. This module previously had no RBAC infrastructure of
// its own whatsoever - every write open to any caller with a valid tenant
// header - unlike integration-hub-service/ai-layer-service, which each
// started with at least their two highest-risk mutations gated.
const RESOURCES = [
  'schedule',
  'forecast',
  'leave_request',
  'user',
  'policy',
  'role',
  'audit',
  'webhook',
  'backdated_leave_entry',
  'ai_provider_config',
  'ai_governance_policy',
  'ai_interaction',
  'ai_recommendation',
  'integration_connector',
  'webhook_subscription',
  // Closes ADR-0150's gap: EmployeeResolver had no guards/permissions at
  // all until now (createEmployee/updateEmployee/transferEmployee were
  // fully open) - added so gating it doesn't lock out every existing
  // caller, same as every other resource here.
  'employee',
  'compliance_rule',
  'compliance_report',
  // Module 06 Phase "Attendance & Leave Manager Views" frontend work: the
  // new manager-scoped `GET /v1/attendance/exceptions` list endpoint needed
  // a permission to gate on and attendance-leave-service had never had a
  // resource of its own for `AttendanceRecord` reads - every prior read
  // path on that entity was the self-service, session-locked employee
  // endpoint, which needs no RBAC permission (the JWT `sub` match is the
  // check). `attendance_record:read` is the only action of this resource
  // actually checked anywhere today; :write/:approve/:delete are generated
  // for symmetry with every other resource here, unused for now.
  'attendance_record',
  // User Management "Time Off" screen gap-fix: LeaveType previously had no
  // CRUD surface at all in attendance-leave-service (seed/read-only) -
  // `leave_type:read`/`leave_type:write` gate the new
  // `LeaveTypeController` there, same generated-per-action-symmetry
  // convention as every other resource here (`:approve`/`:delete` unused
  // for now).
  'leave_type',
  // Closes the previously-disclosed LeaveBalance provisioning gap
  // (attendance-leave-service had no admin write path for `LeaveBalance` at
  // all - see that entity's `LeaveBalanceNotFoundError` doc comment): the
  // new `POST /v1/leave/employees/:employeeId/balances` there is RBAC-gated
  // on `leave_balance:write`, same generated-per-action-symmetry convention
  // as every other resource here (`:read`/`:approve`/`:delete` unused for
  // now - the self-service/manager read path is session- or
  // `leave_request:read`-gated, not this permission).
  'leave_balance',
  // Closes the previously-disclosed LeaveBalance accrual-engine gap (User
  // Management audit GAP-02): attendance-leave-service's new
  // `AccrualPolicyController` (`/v1/accrual-policies`) is RBAC-gated on
  // `accrual_policy:read`/`:write`, same generated-per-action-symmetry
  // convention as every other resource here.
  'accrual_policy',
  // Shift Marketplace Manager View phase: shift-marketplace-service's own
  // first RBAC infrastructure of any kind - every prior mutation/query
  // (`claimOpenShift`, `proposeSwap`, `submitBid`, `approveMarketplaceAction`)
  // ran with no permission check at all. `marketplace_claim:approve` gates
  // the unified approve/reject action for both `MarketplaceClaim` and
  // `SwapRequest` (one shared permission, not a separate resource per
  // entity, since `approveMarketplaceAction`/`rejectMarketplaceAction`
  // already treat the two as one action). `marketplace_post`/`bid_opportunity`
  // are the manager-scoped list-read resources; the existing single-item
  // employee-facing reads (`bid(id)`, `bidOpportunity(id)`,
  // `marketplacePost(id)`) stay ungated, so these permissions only gate the
  // new list/health/approval surface, not Module 11's existing mobile reads.
  'marketplace_post',
  'marketplace_claim',
  'swap_request',
  'bid_opportunity',
  // Analytics & Reporting (Module 09) dashboard-sharing fix: this module's
  // first RBAC infrastructure of any kind (own copy of the identical
  // remote-JWKS AccessTokenGuard/PermissionsGuard/TenantTokenMatchGuard
  // trio ADR-0130/0145/0161 already established) - createDashboard/
  // updateDashboard/dashboard/myDashboards were previously open to any
  // caller with a valid X-Tenant-Id header. `dashboard:read`/`:write` gate
  // those four operations.
  'dashboard',
  // ADR-0164 extends the same guard trio to the rest of Module 09's
  // surface, previously left ungated on purpose (ADR-0163's own disclosed
  // scope boundary) - metricQuery/executiveSummary/metricDefinitions/
  // askAnalyticsQuestion/GET /v1/analytics/metrics/{metricName} under
  // `metric_definition:read`, createMetricDefinition under
  // `metric_definition:write`; POST/GET /v1/analytics/exports under
  // `analytics_export:write`/`:read`.
  'metric_definition',
  'analytics_export',
  // Tenant Admin Integration Management, WP2/WP3: `agent_mapping` reuses
  // the existing `employee`/`employee:read`/`employee:write` permissions
  // (`EmployeeDataSource` is an employee sub-resource, same precedent as
  // schedule preference/interactions/skills) - no new resource needed for
  // it. `reason_code`/`data_source_group` are genuinely new domains
  // (integration-hub-service) with real `:read`/`:write`/`:delete`
  // mutations, unlike most resources here where `:delete` is generated for
  // symmetry only.
  'reason_code',
  'data_source_group',
  // WP5: Historical Import/Backfill (integration-hub-service) - real
  // `:read`/`:write` mutations on `POST/GET .../historical-imports`.
  'historical_import',
  // WP6: Scorecards Sources (analytics-reporting-service) - one resource
  // covering all six Scorecard* entities' real `:read`/`:write`/`:delete`
  // GraphQL operations (`ScorecardSourceResolver`).
  'scorecard_source',
  // Integration Servers (integration-hub-service) - a real, persisted
  // inventory of a tenant's own on-prem recording infrastructure (see
  // `IntegrationServer`'s own doc comment: a registry/system-of-record,
  // not a control plane). Real `:read`/`:write`/`:delete` mutations on
  // `IntegrationServerResolver`.
  'integration_server',
] as const;

/**
 * Incremental, not just idempotent: an early `if (existing.length > 0)
 * return` (the original shape here) means every permission RESOURCES has
 * gained since whenever this DB was first seeded silently never gets
 * backfilled on a later `npm run seed` re-run - discovered when Phase 1's
 * frontend work gated `employee`-resource endpoints for the first time and
 * `tenant_admin` turned out to hold zero `employee:*` permissions despite
 * `employee` having been in RESOURCES for a while (ADR-0150). Computes the
 * full desired set every run and inserts only what's actually missing.
 */
async function seedPermissions(dataSource: typeof AppDataSource): Promise<Permission[]> {
  const repo = dataSource.getRepository(Permission);
  const existing = await repo.find();
  const existingKeys = new Set(existing.map((p) => `${p.resource}:${p.action}`));

  const desired: { resource: string; action: PermissionAction }[] = RESOURCES.flatMap((resource) =>
    Object.values(PermissionAction).map((action) => ({ resource, action })),
  );
  desired.push({ resource: 'tenant', action: PermissionAction.READ });
  desired.push({ resource: 'tenant', action: PermissionAction.WRITE });
  // Tenant Configuration (email/SMTP, security policy, general settings) —
  // same no-approve/no-delete shape as `tenant` itself: this resource is
  // never approved or deleted, only read/written.
  desired.push({ resource: 'tenant_settings', action: PermissionAction.READ });
  desired.push({ resource: 'tenant_settings', action: PermissionAction.WRITE });
  // Tenant Monitoring (internal CS onboarding/health dashboard, analytics-
  // reporting-service): deliberately its own resource, not `tenant:read` —
  // this permission gates a genuinely cross-tenant read (every tenant's
  // onboarding/health rows, not just the caller's own), and `tenant:read` is
  // already bound to `tenant_admin`. A new action on the existing `tenant`
  // resource would inherit that binding via seedSystemRoles' blanket
  // "bind tenant_admin to everything except tenant:delete" rule below,
  // silently handing every tenant admin cross-tenant read. Read-only, and
  // excluded from tenant_admin's binding explicitly, same treatment as
  // `tenant:delete`.
  desired.push({ resource: 'tenant_monitoring', action: PermissionAction.READ });

  const missing = desired.filter((d) => !existingKeys.has(`${d.resource}:${d.action}`));
  if (missing.length === 0) {
    return existing;
  }
  const created = await repo.save(missing.map((m) => repo.create(m)));
  return [...existing, ...created];
}

/** Same incremental reasoning as seedPermissions above - backfills missing system roles AND missing role_permissions bindings for roles that already existed. */
async function seedSystemRoles(dataSource: typeof AppDataSource, permissions: Permission[]): Promise<Role[]> {
  const roleRepo = dataSource.getRepository(Role);
  const rolePermissionRepo = dataSource.getRepository(RolePermission);
  const existingRoles = await roleRepo.find({ where: { isSystemRole: true } });
  const findOrCreate = async (name: string): Promise<Role> => {
    const found = existingRoles.find((r) => r.name === name);
    if (found) return found;
    return roleRepo.save(roleRepo.create({ name, isSystemRole: true, tenantId: null }));
  };

  const platformAdmin = await findOrCreate('platform_admin');
  const tenantAdmin = await findOrCreate('tenant_admin');
  const employee = await findOrCreate('employee');

  const bindMissing = async (role: Role, perms: Permission[]): Promise<void> => {
    const currentBindings = await rolePermissionRepo.find({ where: { roleId: role.id } });
    const boundPermissionIds = new Set(currentBindings.map((b) => b.permissionId));
    const toBind = perms.filter((p) => !boundPermissionIds.has(p.id));
    if (toBind.length > 0) {
      await rolePermissionRepo.save(
        toBind.map((p) => rolePermissionRepo.create({ roleId: role.id, permissionId: p.id })),
      );
    }
  };

  await bindMissing(platformAdmin, permissions);
  await bindMissing(
    tenantAdmin,
    permissions.filter(
      (p) => (p.action !== PermissionAction.DELETE || p.resource !== 'tenant') && p.resource !== 'tenant_monitoring',
    ),
  );
  /**
   * Audit gap-fix: this used to be "every :read permission across every
   * resource in the system" (`p.action === PermissionAction.READ`), which
   * silently handed a base employee account `role:read`, `tenant:read`,
   * `audit:read`, `webhook:read`, `ai_provider_config:read`, etc. - a
   * rank-and-file employee could enumerate every user's email in the
   * tenant via GraphQL `{ users { email } }` (`user:read`), among other
   * things no mobile-app screen (Schedule/Hours/Leave/Marketplace/
   * Adherence/Profile - see mobile-app/app/(tabs)/) actually needs. Least
   * privilege: only the resources those screens genuinely read. Most
   * *individual*-record reads (own attendance, own schedule preference)
   * are session-locked by JWT `sub` match instead and need no permission
   * at all (see e.g. `attendance_record`'s own RESOURCES comment above) -
   * this list is for the *list/catalog* reads a self-service employee
   * still needs (what leave types exist, what shifts are open to claim).
   */
  const EMPLOYEE_SELF_SERVICE_READ_RESOURCES = [
    'employee',
    'schedule',
    'leave_request',
    'leave_type',
    'backdated_leave_entry',
    'attendance_record',
    'marketplace_post',
    'marketplace_claim',
    'swap_request',
    'bid_opportunity',
  ];
  await bindMissing(
    employee,
    permissions.filter(
      (p) => p.action === PermissionAction.READ && EMPLOYEE_SELF_SERVICE_READ_RESOURCES.includes(p.resource),
    ),
  );
  // Prune, not just stop-adding: a tenant seeded before this fix already has
  // the old blanket read grant bound to `employee` in its role_permissions
  // table - `bindMissing` alone would leave those extra bindings in place
  // forever on every re-seed, since it only ever adds. Delete anything
  // currently bound to `employee` whose permission is a :read action for a
  // resource outside the new allowlist.
  const employeeAllowedIds = new Set(
    permissions
      .filter((p) => p.action === PermissionAction.READ && EMPLOYEE_SELF_SERVICE_READ_RESOURCES.includes(p.resource))
      .map((p) => p.id),
  );
  const employeeBindings = await rolePermissionRepo.find({ where: { roleId: employee.id } });
  const permissionById = new Map(permissions.map((p) => [p.id, p]));
  const toRevoke = employeeBindings.filter((b) => {
    const perm = permissionById.get(b.permissionId);
    return perm && perm.action === PermissionAction.READ && !employeeAllowedIds.has(b.permissionId);
  });
  if (toRevoke.length > 0) {
    await rolePermissionRepo.remove(toRevoke);
  }

  return [platformAdmin, tenantAdmin, employee];
}

async function seedDemoTenant(dataSource: typeof AppDataSource): Promise<Tenant> {
  const repo = dataSource.getRepository(Tenant);
  const existing = await repo.findOne({ where: { name: 'Acme Demo Corp' } });
  if (existing) {
    return existing;
  }
  return repo.save(
    repo.create({
      name: 'Acme Demo Corp',
      tier: TenantTier.ENTERPRISE,
      dataResidencyRegion: 'us-east-1',
      status: TenantStatus.ACTIVE,
    }),
  );
}

async function seedDemoUser(dataSource: typeof AppDataSource, tenant: Tenant): Promise<User> {
  const repo = dataSource.getRepository(User);
  const existing = await repo.findOne({ where: { tenantId: tenant.id, email: 'admin@acme-demo.example' } });
  if (existing) {
    return existing;
  }
  return repo.save(
    repo.create({
      tenantId: tenant.id,
      email: 'admin@acme-demo.example',
      status: UserStatus.ACTIVE,
      mfaEnabled: true,
    }),
  );
}

/**
 * A `platform_admin`-role user, homed under the demo tenant like every
 * other seeded user (`User.tenantId` is required - there's no tenantless
 * user row), but whose cross-tenant reach comes entirely from the
 * `platform_admin` role binding (`seedUserRole` below) surfacing in their
 * JWT's `roles` claim - see `TenantContextMiddleware`'s own doc comment for
 * why that, not this user's home tenant, is what `tenants_insert`'s RLS
 * policy actually checks.
 */
async function seedPlatformAdminUser(dataSource: typeof AppDataSource, tenant: Tenant): Promise<User> {
  const repo = dataSource.getRepository(User);
  const existing = await repo.findOne({ where: { tenantId: tenant.id, email: PLATFORM_ADMIN_EMAIL } });
  if (existing) {
    return existing;
  }
  return repo.save(
    repo.create({
      tenantId: tenant.id,
      email: PLATFORM_ADMIN_EMAIL,
      status: UserStatus.ACTIVE,
      mfaEnabled: true,
    }),
  );
}

async function seedUserRole(
  dataSource: typeof AppDataSource,
  tenant: Tenant,
  user: User,
  tenantAdminRole: Role,
): Promise<void> {
  const repo = dataSource.getRepository(UserRole);
  const existing = await repo.findOne({ where: { userId: user.id, roleId: tenantAdminRole.id } });
  if (existing) {
    return;
  }
  await repo.save(
    repo.create({ tenantId: tenant.id, userId: user.id, roleId: tenantAdminRole.id, scopeOrgUnitId: null }),
  );
}

async function seedDemoPolicy(dataSource: typeof AppDataSource, tenant: Tenant): Promise<void> {
  const repo = dataSource.getRepository(Policy);
  const existing = await repo.findOne({ where: { tenantId: tenant.id, policyType: PolicyType.OVERTIME_RULE } });
  if (existing) {
    return;
  }
  // ADR-0006: the first version of a lineage sets policy_group_id = id.
  // policy_group_id is NOT NULL, so the id has to be generated client-side
  // rather than left to the DB default and patched in after insert.
  const id = uuidv4();
  const draft = repo.create({
    id,
    tenantId: tenant.id,
    policyGroupId: id,
    policyType: PolicyType.OVERTIME_RULE,
    definition: { dailyThresholdHours: 8, weeklyThresholdHours: 40, multiplier: 1.5 },
    effectiveFrom: new Date(),
    effectiveTo: null,
    version: 1,
  });
  await repo.save(draft);
}

async function seedAuditTrail(dataSource: typeof AppDataSource, tenant: Tenant, user: User): Promise<void> {
  const repo = dataSource.getRepository(AuditLog);
  await repo.save(
    repo.create({
      tenantId: tenant.id,
      actorId: user.id,
      actorType: AuditActorType.SYSTEM,
      action: 'tenant.provisioned',
      resourceType: 'tenant',
      resourceId: tenant.id,
      beforeState: null,
      afterState: { status: tenant.status },
      aiRationale: null,
    }),
  );
  // Demonstrates §2.2 rule 3: ai_rationale populated for an ai_agent actor.
  await repo.save(
    repo.create({
      tenantId: tenant.id,
      actorId: null,
      actorType: AuditActorType.AI_AGENT,
      action: 'schedule.autogenerated',
      resourceType: 'schedule',
      resourceId: null,
      beforeState: null,
      afterState: { shiftsGenerated: 42 },
      aiRationale: {
        model: 'forecast-optimizer-v1',
        reasoning: 'Balanced coverage against forecast demand within overtime policy v1 constraints.',
      },
    }),
  );
}

async function seedNotificationPreference(dataSource: typeof AppDataSource, tenant: Tenant, user: User): Promise<void> {
  const repo = dataSource.getRepository(NotificationPreference);
  const existing = await repo.findOne({
    where: { userId: user.id, channel: NotificationChannel.EMAIL, eventType: 'schedule_published' },
  });
  if (existing) {
    return;
  }
  await repo.save(
    repo.create({
      tenantId: tenant.id,
      userId: user.id,
      channel: NotificationChannel.EMAIL,
      eventType: 'schedule_published',
      enabled: true,
      quietHoursStart: '22:00:00',
      quietHoursEnd: '07:00:00',
    }),
  );
}

// ---------------------------------------------------------------------------
// Module 02 - Org Structure, Employee, Skills, Calendar
// ---------------------------------------------------------------------------

async function seedOrgUnits(
  dataSource: typeof AppDataSource,
  tenant: Tenant,
): Promise<{ root: OrgUnit; department: OrgUnit; site: OrgUnit }> {
  const repo = dataSource.getRepository(OrgUnit);
  const existingRoot = await repo.findOne({ where: { tenantId: tenant.id, parentOrgUnitId: IsNull() } });
  if (existingRoot) {
    const department = await repo.findOneOrFail({ where: { tenantId: tenant.id, parentOrgUnitId: existingRoot.id } });
    const site = await repo.findOneOrFail({ where: { tenantId: tenant.id, parentOrgUnitId: department.id } });
    return { root: existingRoot, department, site };
  }

  // Saved sequentially, not in parallel: org.fn_org_unit_set_path (Phase 1
  // migration) looks up the parent's row by id, so a child insert must
  // observe its already-committed parent.
  const root = await repo.save(
    repo.create({
      tenantId: tenant.id,
      parentOrgUnitId: null,
      type: OrgUnitType.BUSINESS_UNIT,
      name: 'Acme Demo Corp HQ',
      timezone: 'America/New_York',
      countryCode: 'US',
      status: OrgUnitStatus.ACTIVE,
    }),
  );
  const department = await repo.save(
    repo.create({
      tenantId: tenant.id,
      parentOrgUnitId: root.id,
      type: OrgUnitType.DEPARTMENT,
      name: 'Field Operations',
      timezone: 'America/New_York',
      countryCode: 'US',
      status: OrgUnitStatus.ACTIVE,
    }),
  );
  const site = await repo.save(
    repo.create({
      tenantId: tenant.id,
      parentOrgUnitId: department.id,
      type: OrgUnitType.SITE,
      name: 'Downtown Distribution Site',
      timezone: 'America/New_York',
      countryCode: 'US',
      status: OrgUnitStatus.ACTIVE,
    }),
  );
  return { root, department, site };
}

async function seedSkills(dataSource: typeof AppDataSource, tenant: Tenant): Promise<Skill[]> {
  const repo = dataSource.getRepository(Skill);
  const existing = await repo.find({ where: { tenantId: tenant.id } });
  if (existing.length > 0) {
    return existing;
  }
  return repo.save([
    repo.create({
      tenantId: tenant.id,
      name: 'Forklift Operation',
      category: 'warehouse',
      requiresCertification: true,
      certificationValidityDays: 365,
    }),
    repo.create({
      tenantId: tenant.id,
      name: 'Customer Service',
      category: 'soft_skill',
      requiresCertification: false,
      certificationValidityDays: null,
    }),
  ]);
}

async function seedEmployees(
  dataSource: typeof AppDataSource,
  tenant: Tenant,
  user: User,
  siteOrgUnit: OrgUnit,
): Promise<{ manager: Employee; report: Employee }> {
  const repo = dataSource.getRepository(Employee);
  const existingManager = await repo.findOne({ where: { tenantId: tenant.id, employeeNumber: 'EMP-0001' } });
  if (existingManager) {
    const report = await repo.findOneOrFail({ where: { tenantId: tenant.id, employeeNumber: 'EMP-0002' } });
    return { manager: existingManager, report };
  }

  // Linked to the demo login user - the "has platform access" case.
  const manager = await repo.save(
    repo.create({
      id: uuidv4(),
      tenantId: tenant.id,
      userId: user.id,
      orgUnitId: siteOrgUnit.id,
      employeeNumber: 'EMP-0001',
      employmentType: EmploymentType.FULL_TIME,
      contractHoursPerWeek: '40.00',
      hireDate: '2022-01-10',
      terminationDate: null,
      costCenter: 'CC-100',
      managerEmployeeId: null,
      status: EmployeeStatus.ACTIVE,
    }),
  );
  // §2.2 rule 2: userId left null - headcount-only, no login access.
  const report = await repo.save(
    repo.create({
      id: uuidv4(),
      tenantId: tenant.id,
      userId: null,
      orgUnitId: siteOrgUnit.id,
      employeeNumber: 'EMP-0002',
      employmentType: EmploymentType.PART_TIME,
      contractHoursPerWeek: '20.00',
      hireDate: '2023-06-01',
      terminationDate: null,
      costCenter: 'CC-100',
      managerEmployeeId: manager.id,
      status: EmployeeStatus.ACTIVE,
    }),
  );
  return { manager, report };
}

async function seedEmployeeSkills(
  dataSource: typeof AppDataSource,
  tenant: Tenant,
  report: Employee,
  skills: Skill[],
): Promise<void> {
  const repo = dataSource.getRepository(EmployeeSkill);
  const forklift = skills.find((s) => s.name === 'Forklift Operation')!;
  const existing = await repo.findOne({ where: { tenantId: tenant.id, employeeId: report.id, skillId: forklift.id } });
  if (existing) {
    return;
  }
  // expiryDate is left unset here - org.fn_employee_skill_set_expiry (Phase
  // 1 migration) derives it from certifiedDate + the skill's
  // certification_validity_days on insert.
  await repo.save(
    repo.create({
      tenantId: tenant.id,
      employeeId: report.id,
      skillId: forklift.id,
      proficiencyLevel: ProficiencyLevel.PROFICIENT,
      certifiedDate: '2025-01-15',
      lastScheduledOnSkillAt: null,
    }),
  );
}

async function seedWorkingTimeCalendar(dataSource: typeof AppDataSource, tenant: Tenant): Promise<void> {
  const repo = dataSource.getRepository(WorkingTimeCalendar);
  const existing = await repo.findOne({ where: { tenantId: tenant.id, orgUnitId: IsNull() } });
  if (existing) {
    return;
  }
  await repo.save(
    repo.create({
      tenantId: tenant.id,
      orgUnitId: null,
      countryCode: 'US',
      holidayDates: ['2026-01-01', '2026-07-04', '2026-12-25'],
      standardBusinessHours: { monday: ['09:00', '17:00'], tuesday: ['09:00', '17:00'] },
    }),
  );
}

async function seedEmploymentPolicy(
  dataSource: typeof AppDataSource,
  tenant: Tenant,
  department: OrgUnit,
): Promise<void> {
  const repo = dataSource.getRepository(Policy);
  const existing = await repo.findOne({
    where: { tenantId: tenant.id, policyType: PolicyType.OVERTIME_THRESHOLD, orgUnitId: department.id },
  });
  if (existing) {
    return;
  }
  // ADR-0006/ADR-0012: same lineage pattern as core policies, scoped to one
  // org unit via orgUnitId instead of tenant-wide.
  const id = uuidv4();
  await repo.save(
    repo.create({
      id,
      tenantId: tenant.id,
      policyGroupId: id,
      policyType: PolicyType.OVERTIME_THRESHOLD,
      orgUnitId: department.id,
      definition: { dailyThresholdHours: 8, weeklyThresholdHours: 38, multiplier: 1.5 },
      effectiveFrom: new Date(),
      effectiveTo: null,
      version: 1,
    }),
  );
}

// ---------------------------------------------------------------------------
// Module 01 Phase 2 - Identity core (signing key, local password bootstrap,
// demo OAuth clients)
// ---------------------------------------------------------------------------

// Local dev only - never a real credential. Printed at the end of this
// script so a developer driving the OAuth flow by hand knows it.
const DEMO_PASSWORD = 'ChangeMe123!';
// Local dev only - the platform-admin account used to exercise the
// top-level (parentless) tenant-creation path, which only a real
// `platform_admin`-role JWT can reach (see `tenants_insert` RLS policy).
const PLATFORM_ADMIN_EMAIL = 'vishnubalaguru@agnoshin.com';
const PLATFORM_ADMIN_PASSWORD = 'Vishnu@123';

async function seedSigningKey(dataSource: typeof AppDataSource): Promise<void> {
  const repo = dataSource.getRepository(SigningKey);
  const existing = await repo.findOne({ where: { status: SigningKeyStatus.ACTIVE } });
  if (existing) {
    return;
  }
  // Mirrors SigningKeyService's own bootstrap (ADR-0024) - duplicated here,
  // not imported, because this script deliberately talks to Postgres
  // directly rather than booting the Nest DI container (see this file's own
  // top-of-file doc comment).
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  await repo.save(
    repo.create({
      kid: randomUUID(),
      algorithm: 'RS256',
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
      status: SigningKeyStatus.ACTIVE,
      retiredAt: null,
    }),
  );
}

async function seedPasswordCredential(
  dataSource: typeof AppDataSource,
  tenant: Tenant,
  user: User,
  password: string,
): Promise<void> {
  const repo = dataSource.getRepository(UserCredential);
  const existing = await repo.findOne({ where: { userId: user.id } });
  if (existing) {
    return;
  }
  const passwordHash = await bcrypt.hash(password, await bcrypt.genSalt(10));
  await repo.save(
    repo.create({
      userId: user.id,
      tenantId: tenant.id,
      passwordHash,
      passwordAlgorithm: 'bcrypt',
      passwordUpdatedAt: new Date(),
      failedLoginAttempts: 0,
      lockedUntil: null,
    }),
  );
}

async function seedOAuthClients(dataSource: typeof AppDataSource, tenant: Tenant): Promise<void> {
  const repo = dataSource.getRepository(OAuthClient);

  const existingPublic = await repo.findOne({ where: { tenantId: tenant.id, clientId: 'demo-web-app' } });
  if (!existingPublic) {
    // Public (PKCE) client - the demo.acme-demo.example web app authenticating
    // the demo user via POST /oauth/authorize + POST /oauth/token.
    await repo.save(
      repo.create({
        tenantId: tenant.id,
        clientId: 'demo-web-app',
        clientSecretHash: null,
        clientType: OAuthClientType.PUBLIC,
        name: 'Demo Web App (PKCE)',
        allowedGrantTypes: [OAuthGrantType.AUTHORIZATION_CODE, OAuthGrantType.REFRESH_TOKEN],
        redirectUris: ['http://localhost:3000/callback'],
        tokenEndpointAuthMethod: TokenEndpointAuthMethod.NONE,
        isActive: true,
      }),
    );
  }

  const existingMobile = await repo.findOne({ where: { tenantId: tenant.id, clientId: 'wfm-mobile-app' } });
  if (!existingMobile) {
    // Public (PKCE) client - Module 11's mobile-app (Phase 2, docs/adr/0150).
    // redirectUris is exact-string validated by /oauth/authorize and
    // /oauth/token even though POST /oauth/authorize returns the code
    // directly in its JSON response body rather than actually redirecting
    // anywhere (ADR-0026) - this value just has to match what mobile-app
    // sends, matching its own app.config.ts `scheme: 'agnowfm'`.
    await repo.save(
      repo.create({
        tenantId: tenant.id,
        clientId: 'wfm-mobile-app',
        clientSecretHash: null,
        clientType: OAuthClientType.PUBLIC,
        name: 'WFM Mobile App (PKCE)',
        allowedGrantTypes: [OAuthGrantType.AUTHORIZATION_CODE, OAuthGrantType.REFRESH_TOKEN],
        redirectUris: ['agnowfm://oauth/callback'],
        tokenEndpointAuthMethod: TokenEndpointAuthMethod.NONE,
        isActive: true,
      }),
    );
  }

  const existingConfidential = await repo.findOne({
    where: { tenantId: tenant.id, clientId: 'demo-service-integration' },
  });
  if (!existingConfidential) {
    // Confidential client - demonstrates POST /oauth/token's client_credentials
    // grant for a server-to-server integration. Secret is a fixed local-dev
    // value on purpose (so this seed stays deterministic/idempotent); a real
    // registration goes through POST /oauth/register instead.
    const secretHash = await bcrypt.hash('demo_service_secret_local_only', await bcrypt.genSalt(10));
    await repo.save(
      repo.create({
        tenantId: tenant.id,
        clientId: 'demo-service-integration',
        clientSecretHash: secretHash,
        clientType: OAuthClientType.CONFIDENTIAL,
        name: 'Demo Service Integration (client_credentials)',
        allowedGrantTypes: [OAuthGrantType.CLIENT_CREDENTIALS],
        redirectUris: [],
        tokenEndpointAuthMethod: TokenEndpointAuthMethod.CLIENT_SECRET_BASIC,
        isActive: true,
      }),
    );
  }
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  try {
    const permissions = await seedPermissions(AppDataSource);
    const [platformAdmin, tenantAdmin] = await seedSystemRoles(AppDataSource, permissions);
    const tenant = await seedDemoTenant(AppDataSource);
    const user = await seedDemoUser(AppDataSource, tenant);
    await seedUserRole(AppDataSource, tenant, user, tenantAdmin);
    const platformAdminUser = await seedPlatformAdminUser(AppDataSource, tenant);
    await seedUserRole(AppDataSource, tenant, platformAdminUser, platformAdmin);
    await seedDemoPolicy(AppDataSource, tenant);
    await seedAuditTrail(AppDataSource, tenant, user);
    await seedNotificationPreference(AppDataSource, tenant, user);

    const { department, site } = await seedOrgUnits(AppDataSource, tenant);
    const skills = await seedSkills(AppDataSource, tenant);
    const { report } = await seedEmployees(AppDataSource, tenant, user, site);
    await seedEmployeeSkills(AppDataSource, tenant, report, skills);
    await seedWorkingTimeCalendar(AppDataSource, tenant);
    await seedEmploymentPolicy(AppDataSource, tenant, department);

    await seedSigningKey(AppDataSource);
    await seedPasswordCredential(AppDataSource, tenant, user, DEMO_PASSWORD);
    await seedPasswordCredential(AppDataSource, tenant, platformAdminUser, PLATFORM_ADMIN_PASSWORD);
    await seedOAuthClients(AppDataSource, tenant);

    // eslint-disable-next-line no-console
    console.log('Seed complete.');
    // eslint-disable-next-line no-console
    console.log(
      `Demo login: admin@acme-demo.example / ${DEMO_PASSWORD} - demo-web-app (public/PKCE), ` +
        'demo-service-integration (confidential, secret: demo_service_secret_local_only).',
    );
    // eslint-disable-next-line no-console
    console.log(
      `Platform-admin login: ${PLATFORM_ADMIN_EMAIL} / ${PLATFORM_ADMIN_PASSWORD} - demo-web-app (public/PKCE).`,
    );
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', err);
  process.exitCode = 1;
});
