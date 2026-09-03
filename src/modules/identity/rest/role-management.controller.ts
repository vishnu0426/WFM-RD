import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { UserContextCacheService } from '../../auth/services/user-context-cache.service';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';
import { RoleManagementService } from '../services/role-management.service';
import { CreateRoleDto } from '../dto/create-role.dto';
import { UpdateRoleDto } from '../dto/update-role.dto';
import { BindPermissionDto } from '../dto/bind-permission.dto';
import { AssignRoleDto } from '../dto/assign-role.dto';
import { Role } from '../entities/role.entity';
import { Permission } from '../entities/permission.entity';
import { UserRole } from '../entities/user-role.entity';
import { RoleUserRow } from '../repositories/roles.repository';

/**
 * §4's RBAC/ABAC management surface. Lives in `IdentityApiModule` (not
 * `IdentityModule` itself) for the same reason `PolicyManagementController`
 * lives in `PolicyApiModule` - see that module's doc comment. Every mutation
 * that can change a *currently live* user's effective permissions
 * (`bindPermission`/`unbindPermission`/`assign`/`revoke`) invalidates
 * `UserContextCacheService`'s cache for every affected user immediately
 * after - closing the gap that service's own doc comment flagged back in
 * Phase 2 ("no mutation API exists yet ... TTL expiry is the only
 * invalidation path"). Bounded by the 60s TTL as the backstop either way.
 *
 * Phase 5 (§4): every mutation also records an `audit_log` entry - one of
 * the representative write paths this phase wires end to end (alongside
 * `PolicyManagementController`), not an exhaustive retrofit of every
 * mutation across every phase (see docs/phase-5-design-doc.md).
 */
@Controller()
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class RoleManagementController {
  constructor(
    private readonly service: RoleManagementService,
    private readonly userContextCache: UserContextCacheService,
    private readonly tenantContext: TenantContextService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  @Get('v1/roles')
  @RequirePermissions('role:read')
  async listRoles(): Promise<Role[]> {
    return this.service.listRoles();
  }

  @Get('v1/roles/:id')
  @RequirePermissions('role:read')
  async getRole(@Param('id') id: string): Promise<Role> {
    return this.service.getRoleOrFailIncludingSystem(id);
  }

  @Post('v1/roles')
  @RequirePermissions('role:write')
  async createRole(@Req() req: RequestWithTokenClaims, @Body() dto: CreateRoleDto): Promise<Role> {
    const role = await this.service.createRole(dto);
    await this.audit(req, 'role.created', 'role', role.id, null, { name: role.name });
    return role;
  }

  @Patch('v1/roles/:id')
  @RequirePermissions('role:write')
  async updateRole(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
  ): Promise<Role> {
    const role = await this.service.updateRole(id, dto);
    await this.invalidateAll(await this.service.userIdsWithRole(id));
    await this.audit(req, 'role.updated', 'role', id, null, dto as Record<string, unknown>);
    return role;
  }

  @Get('v1/roles/:id/users')
  @RequirePermissions('role:read')
  async usersWithRole(@Param('id') id: string): Promise<RoleUserRow[]> {
    return this.service.usersWithRole(id);
  }

  @Delete('v1/roles/:id')
  @RequirePermissions('role:delete')
  async deleteRole(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<{ deleted: true }> {
    const role = await this.service.getRoleOrFail(id);
    const userIds = await this.service.userIdsWithRole(id);
    await this.service.deleteRole(id);
    await this.invalidateAll(userIds);
    await this.audit(req, 'role.deleted', 'role', id, { name: role.name }, null);
    return { deleted: true };
  }

  @Get('v1/permissions')
  @RequirePermissions('role:read')
  async listPermissions(): Promise<Permission[]> {
    return this.service.listPermissions();
  }

  /**
   * Frontend Phase 8 gap-fix: §0 rule 1's specific-consequence-confirmation
   * principle needs a real number before an admin edits/deletes a role
   * ("this affects N users"), and nothing exposed `RoleManagementService.userIdsWithRole`
   * (used internally only for cache invalidation) until now.
   */
  @Get('v1/roles/:id/user-count')
  @RequirePermissions('role:read')
  async getRoleUserCount(@Param('id') id: string): Promise<{ count: number }> {
    await this.service.getRoleOrFailIncludingSystem(id);
    const userIds = await this.service.userIdsWithRole(id);
    return { count: userIds.length };
  }

  @Get('v1/roles/:id/permissions')
  @RequirePermissions('role:read')
  async listRolePermissions(@Param('id') id: string): Promise<Permission[]> {
    return this.service.listPermissionsForRole(id);
  }

  @Post('v1/roles/:id/permissions')
  @RequirePermissions('role:write')
  async bindPermission(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @Body() dto: BindPermissionDto,
  ): Promise<{ bound: true }> {
    await this.service.bindPermission(id, dto.permissionId);
    await this.invalidateAll(await this.service.userIdsWithRole(id));
    await this.audit(req, 'role.permission.bound', 'role', id, null, { permissionId: dto.permissionId });
    return { bound: true };
  }

  @Delete('v1/roles/:id/permissions/:permissionId')
  @RequirePermissions('role:write')
  async unbindPermission(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @Param('permissionId') permissionId: string,
  ): Promise<{ unbound: true }> {
    const userIds = await this.service.userIdsWithRole(id);
    await this.service.unbindPermission(id, permissionId);
    await this.invalidateAll(userIds);
    await this.audit(req, 'role.permission.unbound', 'role', id, { permissionId }, null);
    return { unbound: true };
  }

  @Get('v1/users/:userId/roles')
  @RequirePermissions('role:read')
  async listUserRoles(@Param('userId') userId: string): Promise<UserRole[]> {
    return this.service.listRoleAssignments(userId);
  }

  @Post('v1/users/:userId/roles')
  @RequirePermissions('role:write')
  async assignRole(
    @Req() req: RequestWithTokenClaims,
    @Param('userId') userId: string,
    @Body() dto: AssignRoleDto,
  ): Promise<UserRole> {
    const assignment = await this.service.assignRole(
      userId,
      dto.roleId,
      dto.scopeOrgUnitId ?? null,
      dto.scopeGroupId ?? null,
    );
    await this.invalidateAll([userId]);
    await this.audit(req, 'user_role.assigned', 'user', userId, null, {
      roleId: dto.roleId,
      scopeOrgUnitId: dto.scopeOrgUnitId ?? null,
      scopeGroupId: dto.scopeGroupId ?? null,
    });
    return assignment;
  }

  @Delete('v1/users/:userId/roles/:roleId')
  @RequirePermissions('role:write')
  async revokeRole(
    @Req() req: RequestWithTokenClaims,
    @Param('userId') userId: string,
    @Param('roleId') roleId: string,
    @Query('scopeOrgUnitId') scopeOrgUnitId?: string,
    @Query('scopeGroupId') scopeGroupId?: string,
  ): Promise<{ revoked: true }> {
    await this.service.revokeRole(userId, roleId, scopeOrgUnitId ?? null, scopeGroupId ?? null);
    await this.invalidateAll([userId]);
    await this.audit(
      req,
      'user_role.revoked',
      'user',
      userId,
      { roleId, scopeOrgUnitId: scopeOrgUnitId ?? null, scopeGroupId: scopeGroupId ?? null },
      null,
    );
    return { revoked: true };
  }

  private async invalidateAll(userIds: string[]): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    await Promise.all(userIds.map((userId) => this.userContextCache.invalidate(tenantId, userId)));
  }

  private async audit(
    req: RequestWithTokenClaims,
    action: string,
    resourceType: string,
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
      resourceType,
      resourceId,
      beforeState,
      afterState,
      aiRationale: null,
    });
  }
}
