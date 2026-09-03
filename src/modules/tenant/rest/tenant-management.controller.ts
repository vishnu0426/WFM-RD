import { Body, Controller, ForbiddenException, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantsRepository } from '../repositories/tenants.repository';
import { CreateTenantDto } from '../dto/create-tenant.dto';
import { UpdateTenantDto } from '../dto/update-tenant.dto';
import { ProvisionTenantAdminDto } from '../dto/provision-tenant-admin.dto';
import { TenantStatus } from '../entities/tenant-status.enum';
import { Tenant } from '../entities/tenant.entity';
import { TenantNotFoundError } from '../errors/tenant-not-found.error';
import { TenantNotProvisioningError } from '../errors/tenant-not-provisioning.error';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { UserRolesRepository } from '../../identity/repositories/user-roles.repository';
import { RolesRepository } from '../../identity/repositories/roles.repository';
import { InviteTokenService } from '../../identity/services/invite-token.service';
import { UserStatus } from '../../identity/entities/user-status.enum';
import { User } from '../../identity/entities/user.entity';
import { EmailAlreadyInUseError } from '../../identity/errors/email-already-in-use.error';
import { OrgUnitsService } from '../../org-unit/services/org-units.service';
import { CreateOrgUnitInput } from '../../org-unit/dto/create-org-unit.input';
import { OrgUnit } from '../../org-unit/entities/org-unit.entity';
import { SlugAlreadyInUseError } from '../errors/slug-already-in-use.error';
import { TenantSettingsService } from '../../tenant-settings/tenant-settings.service';
import { TenantSettingsView } from '../../tenant-settings/rest/tenant-settings.view';
import { UpdateWfmDefaultsDto } from '../../tenant-settings/dto/update-wfm-defaults.dto';

/**
 * §3.2's `/v1/tenants` (Phase 6) - the REST admin surface over `Tenant`/
 * `TenantsRepository`, which existed since Phase 1 but had no HTTP surface
 * of its own until now (every earlier phase read/wrote tenants only via
 * fixtures or other modules' own tenant-scoped writes). Lives in
 * `TenantApiModule` for the same reason `RoleManagementController` lives in
 * `IdentityApiModule` - see that module's doc comment.
 *
 * No hard-delete endpoint: `TenantsRepository` has no delete method (tenants
 * are deprovisioned via `status`, not removed - consistent with this
 * platform's audit/retention posture elsewhere), so there is nothing for a
 * DELETE handler to call.
 */
@Controller('v1/tenants')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class TenantManagementController {
  constructor(
    private readonly tenants: TenantsRepository,
    private readonly auditLog: AuditLogRepository,
    private readonly tenantContext: TenantContextService,
    private readonly usersRepository: UsersRepository,
    private readonly userRolesRepository: UserRolesRepository,
    private readonly rolesRepository: RolesRepository,
    private readonly inviteTokenService: InviteTokenService,
    private readonly orgUnitsService: OrgUnitsService,
    private readonly tenantSettingsService: TenantSettingsService,
  ) {}

  @Get('self')
  @RequirePermissions('tenant:read')
  async self(): Promise<Tenant> {
    const tenant = await this.tenants.findSelf();
    if (!tenant) {
      throw new TenantNotFoundError('self');
    }
    return tenant;
  }

  @Get()
  @RequirePermissions('tenant:read')
  async children(@Query('parentTenantId') parentTenantId?: string): Promise<Tenant[]> {
    const self = await this.tenants.findSelf();
    return this.tenants.findChildren(parentTenantId ?? self?.id ?? '');
  }

  /**
   * Tenant Monitoring console's "All Tenants" list (internal, platform_admin
   * only) - every tenant in the system, not just the caller's own tenant +
   * children `children()` above returns. Registered before `:id` (same
   * literal-before-param ordering `self` above already establishes) so
   * `all` is never swallowed as an `:id` value. Hard role check, same style
   * as `provisionAdmin` below - belt-and-suspenders on top of
   * `TenantsRepository.findAll`'s own RLS-based restriction, not a
   * replacement for it.
   */
  @Get('all')
  @RequirePermissions('tenant:read')
  async all(@Req() req: RequestWithTokenClaims): Promise<Tenant[]> {
    if (!req.tokenClaims!.roles.includes('platform_admin')) {
      throw new ForbiddenException('Only a platform admin may list every tenant.');
    }
    return this.tenants.findAll();
  }

  @Get(':id')
  @RequirePermissions('tenant:read')
  async get(@Param('id') id: string): Promise<Tenant> {
    const tenant = await this.tenants.findById(id);
    if (!tenant) {
      throw new TenantNotFoundError(id);
    }
    return tenant;
  }

  @Post()
  @RequirePermissions('tenant:write')
  async create(@Req() req: RequestWithTokenClaims, @Body() dto: CreateTenantDto): Promise<Tenant> {
    const claims = req.tokenClaims!;
    // Mirrors `tenants_insert`'s own WITH CHECK exactly (platform_admin OR
    // parent_tenant_id = caller's own tenant) so a disallowed attempt fails
    // cleanly here with a 403 instead of falling through to the RLS policy,
    // which rejects the raw INSERT with an unhandled exception that
    // otherwise surfaces as a bare 500 (found live: a tenant_admin's
    // attempt to create a top-level tenant 500'd instead of 403'ing).
    if (!claims.roles.includes('platform_admin') && dto.parentTenantId !== claims.tenant_id) {
      throw new ForbiddenException(
        'Only a platform admin may create a top-level tenant; a tenant admin may only onboard a BPO child under their own tenant.',
      );
    }
    const existingSlug = await this.tenants.findBySlug(dto.slug);
    if (existingSlug) {
      throw new SlugAlreadyInUseError(dto.slug);
    }
    const created = await this.tenants.create({
      name: dto.name,
      tier: dto.tier,
      dataResidencyRegion: dto.dataResidencyRegion,
      parentTenantId: dto.parentTenantId ?? null,
      status: TenantStatus.PROVISIONING,
      slug: dto.slug,
      industry: dto.industry ?? null,
      country: dto.country ?? null,
      currency: dto.currency ?? null,
      language: dto.language ?? null,
    });
    await this.audit(req, 'tenant.created', created.id, null, {
      name: created.name,
      tier: created.tier,
      status: created.status,
      slug: created.slug,
    });
    return created;
  }

  @Put(':id')
  @RequirePermissions('tenant:write')
  async update(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @Body() dto: UpdateTenantDto,
  ): Promise<Tenant> {
    // `tenants_update`'s RLS policy deliberately lets a tenant admin update
    // their own row (self-rename) or a direct BPO child they own - that's
    // correct and intentional (see the migration's own comment). What RLS
    // *can't* express is "which columns" - tier/status/dataResidencyRegion
    // are platform-controlled (plan tier, lifecycle state, compliance
    // region), not self-service fields. Found live: a tenant_admin could
    // silently change their own tier and region with no gate at all.
    if (
      !req.tokenClaims!.roles.includes('platform_admin') &&
      (dto.tier !== undefined || dto.status !== undefined || dto.dataResidencyRegion !== undefined)
    ) {
      throw new ForbiddenException('Only a platform admin may change tier, status, or data residency region.');
    }
    const before = await this.tenants.findById(id);
    if (!before) {
      throw new TenantNotFoundError(id);
    }
    await this.tenants.update(id, dto);
    const after = await this.tenants.findById(id);
    await this.audit(
      req,
      'tenant.updated',
      id,
      { name: before.name, tier: before.tier, status: before.status },
      { name: after!.name, tier: after!.tier, status: after!.status },
    );
    return after!;
  }

  /**
   * Onboarding gap-fix: the missing piece between "create a tenant" (above)
   * and that tenant actually having someone who can log in. Deliberately
   * narrow - only ever targets a brand-new tenant still `PROVISIONING`, not
   * a general "add an admin to any existing customer" tool (that's a
   * materially more sensitive capability, not this endpoint's job).
   *
   * `RequirePermissions('tenant:write')` alone isn't enough here - an
   * ordinary tenant_admin can hold that for their *own* tenant, but this
   * writes into an arbitrary *other* tenant, so it also requires the
   * caller's own JWT to carry `platform_admin` - the same claim
   * `TenantContextMiddleware` itself already trusts for `isPlatformAdmin`,
   * not a client-suppliable header.
   *
   * Runs the actual writes inside `tenantContext.run({ tenantId: id }, ...)`
   * - the exact no-ambient-context-needed pattern `acceptInvite`
   * (`user-management.controller.ts`) already proves safe: RLS checks the
   * GUC this sets, not the caller's own original session tenant.
   */
  @Post(':id/provision-admin')
  @RequirePermissions('tenant:write')
  async provisionAdmin(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @Body() dto: ProvisionTenantAdminDto,
  ): Promise<{ user: User; expiresAt: Date }> {
    const claims = req.tokenClaims!;
    if (!claims.roles.includes('platform_admin')) {
      throw new ForbiddenException('Only a platform admin may provision another tenant’s first admin.');
    }

    const tenant = await this.tenants.findById(id);
    if (!tenant) {
      throw new TenantNotFoundError(id);
    }
    if (tenant.status !== TenantStatus.PROVISIONING) {
      throw new TenantNotProvisioningError(id, tenant.status);
    }

    const { user, expiresAt } = await this.tenantContext.run({ tenantId: id }, async () => {
      const existing = await this.usersRepository.findByEmail(dto.email);
      if (existing) {
        throw new EmailAlreadyInUseError(dto.email);
      }

      const createdUser = await this.usersRepository.save({
        tenantId: id,
        email: dto.email,
        givenName: dto.givenName ?? null,
        familyName: dto.familyName ?? null,
        phone: dto.phone ?? null,
        jobTitle: dto.jobTitle ?? null,
        status: UserStatus.INVITED,
        mfaEnabled: false,
      } as never);

      const roles = await this.rolesRepository.findAllIncludingSystem();
      const tenantAdminRole = roles.find((r) => r.isSystemRole && r.name === 'tenant_admin');
      if (!tenantAdminRole) {
        throw new Error("System role 'tenant_admin' is missing - re-run the platform seed.");
      }
      await this.userRolesRepository.assign(createdUser.id, tenantAdminRole.id, null);

      const inviteExpiresAt = await this.inviteTokenService.issue(id, createdUser.id, dto.email);
      await this.tenants.update(id, { status: TenantStatus.ACTIVE });

      // Not the shared `audit()` helper below: this records under the
      // *target* tenant (`id`), not `claims.tenant_id` (the calling
      // platform admin's own tenant) - "how was our first admin created"
      // belongs in the new tenant's own audit trail, the same one every
      // other action inside it will be recorded under from here on. Must
      // run inside this same tenantContext.run(...) block, not after it -
      // AuditLogRepository.record() requires entry.tenantId to match the
      // *ambient* bound context (TenantMismatchError otherwise), and that
      // context reverts to the caller's own tenant the instant this
      // callback returns. Bug found live: this call originally sat after
      // the run() block and threw TENANT_MISMATCH on every real
      // provisioning attempt - confirmed via getStore() tracing, not a
      // guess.
      await this.auditLog.record({
        tenantId: id,
        actorId: claims.sub,
        actorType: AuditActorType.USER,
        action: 'tenant.admin_provisioned',
        resourceType: 'tenant',
        resourceId: id,
        beforeState: null,
        afterState: { email: dto.email, userId: createdUser.id },
        aiRationale: null,
      });

      return { user: createdUser, expiresAt: inviteExpiresAt };
    });
    return { user, expiresAt };
  }

  /**
   * Tenant Monitoring onboarding checklist (internal CS tool): the
   * "Organization" accordion panel's create action. Same shape as
   * `provisionAdmin` above - hard `platform_admin` role check (an ordinary
   * tenant_admin's own `employee:write` already lets them create org units
   * for their *own* tenant via the GraphQL `createOrgUnit` mutation; this
   * REST endpoint exists specifically for the cross-tenant, brand-new-
   * tenant-with-no-ambient-session case), writes wrapped in
   * `tenantContext.run({ tenantId: id }, ...)`, and the audit entry
   * recorded *inside* that same block - see `provisionAdmin`'s own doc
   * comment for why an audit write placed after the block exits throws
   * `TENANT_MISMATCH` (found and fixed live, not a guess).
   */
  @Post(':id/provision-org-unit')
  @RequirePermissions('tenant:write')
  async provisionOrgUnit(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @Body() dto: CreateOrgUnitInput,
  ): Promise<OrgUnit> {
    const claims = req.tokenClaims!;
    if (!claims.roles.includes('platform_admin')) {
      throw new ForbiddenException('Only a platform admin may provision another tenant’s organization.');
    }

    const tenant = await this.tenants.findById(id);
    if (!tenant) {
      throw new TenantNotFoundError(id);
    }

    return this.tenantContext.run({ tenantId: id }, async () => {
      const orgUnit = await this.orgUnitsService.create(dto);
      await this.auditLog.record({
        tenantId: id,
        actorId: claims.sub,
        actorType: AuditActorType.USER,
        action: 'org_unit.provisioned',
        resourceType: 'org_unit',
        resourceId: orgUnit.id,
        beforeState: null,
        afterState: { name: orgUnit.name, type: orgUnit.type },
        aiRationale: null,
      });
      return orgUnit;
    });
  }

  /**
   * Tenant Monitoring onboarding checklist: the "Organization" panel's
   * derived-status read - true only once this tenant genuinely has at
   * least one org unit (`OrgUnitsService.hasAnyOrgUnits`), never a stored
   * progress flag. Read-only, but still platform-admin-gated and wrapped
   * the same way - it's still a cross-tenant read of another tenant's data.
   */
  @Get(':id/org-units/exists')
  @RequirePermissions('tenant:read')
  async orgUnitsExist(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<{ hasOrgUnits: boolean }> {
    if (!req.tokenClaims!.roles.includes('platform_admin')) {
      throw new ForbiddenException('Only a platform admin may check another tenant’s organization status.');
    }
    const hasOrgUnits = await this.tenantContext.run({ tenantId: id }, () => this.orgUnitsService.hasAnyOrgUnits());
    return { hasOrgUnits };
  }

  /**
   * Tenant Monitoring onboarding checklist: the "WFM Configuration" panel's
   * read/write pair - same cross-tenant `tenantContext.run({tenantId: id},
   * ...)` wrap as every other platform_admin-only endpoint here, over
   * `TenantSettingsService`'s existing own-tenant methods (the same ones
   * `TenantSettingsController`'s `GET /`/`PUT /wfm-defaults` use for a
   * tenant admin configuring their own tenant later).
   */
  @Get(':id/wfm-defaults')
  @RequirePermissions('tenant:read')
  async getWfmDefaults(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<TenantSettingsView> {
    if (!req.tokenClaims!.roles.includes('platform_admin')) {
      throw new ForbiddenException('Only a platform admin may read another tenant’s WFM defaults.');
    }
    return this.tenantContext.run({ tenantId: id }, () => this.tenantSettingsService.getSettings());
  }

  @Put(':id/wfm-defaults')
  @RequirePermissions('tenant:write')
  async updateWfmDefaults(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @Body() dto: UpdateWfmDefaultsDto,
  ): Promise<TenantSettingsView> {
    const claims = req.tokenClaims!;
    if (!claims.roles.includes('platform_admin')) {
      throw new ForbiddenException('Only a platform admin may configure another tenant’s WFM defaults.');
    }
    return this.tenantContext.run({ tenantId: id }, async () => {
      const before = await this.tenantSettingsService.getSettings();
      const after = await this.tenantSettingsService.updateWfmDefaults(dto);
      await this.auditLog.record({
        tenantId: id,
        actorId: claims.sub,
        actorType: AuditActorType.USER,
        action: 'tenant_settings.wfm_defaults_updated',
        resourceType: 'tenant_settings',
        resourceId: after.id,
        beforeState: { weekStartDay: before.weekStartDay, dayBoundary: before.dayBoundary },
        afterState: { weekStartDay: after.weekStartDay, dayBoundary: after.dayBoundary },
        aiRationale: null,
      });
      return after;
    });
  }

  private async audit(
    req: RequestWithTokenClaims,
    action: string,
    resourceId: string,
    beforeState: Record<string, unknown> | null,
    afterState: Record<string, unknown> | null,
  ): Promise<void> {
    const claims = req.tokenClaims!;
    await this.auditLog.record({
      tenantId: claims.tenant_id,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action,
      resourceType: 'tenant',
      resourceId,
      beforeState,
      afterState,
      aiRationale: null,
    });
  }
}
