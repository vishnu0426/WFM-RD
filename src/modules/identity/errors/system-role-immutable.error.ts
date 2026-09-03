import { DomainError } from '../../../common/errors/domain-error';

/** `RoleManagementService.updateRole` refuses to edit a platform-shipped system role (`Role.isSystemRole`) - `platform_admin`/`tenant_admin`/`employee` are seed-only data (see `RolesRepository`'s own doc comment), not tenant-editable. */
export class SystemRoleImmutableError extends DomainError {
  readonly code = 'SYSTEM_ROLE_IMMUTABLE';

  constructor(id: string) {
    super(`Role ${id} is a system role and cannot be modified.`, { id });
  }
}
