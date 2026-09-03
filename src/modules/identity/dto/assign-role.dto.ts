import { IsOptional, IsUUID } from 'class-validator';

/**
 * `scopeOrgUnitId`/`scopeGroupId` both omitted/null = tenant-wide grant;
 * exactly one present = ABAC-scoped to that org unit or that Employee
 * Group (§2.1). Mutual exclusivity is enforced in
 * `RoleManagementService.assignRole`, not here — cross-field validation
 * belongs at the service boundary where both values are already resolved,
 * matching this module's existing convention (see e.g. `SystemRoleImmutableError`).
 */
export class AssignRoleDto {
  @IsUUID()
  roleId!: string;

  @IsOptional()
  @IsUUID()
  scopeOrgUnitId?: string;

  @IsOptional()
  @IsUUID()
  scopeGroupId?: string;
}
