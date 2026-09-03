import { DomainError } from '../../../common/errors/domain-error';

/** `RoleManagementService.assignRole` refuses a grant that sets both `scopeOrgUnitId` and `scopeGroupId` — the two scope axes are mutually exclusive (also enforced by a DB CHECK constraint, see the UserRoleGroupScope migration). */
export class InvalidRoleScopeError extends DomainError {
  readonly code = 'INVALID_ROLE_SCOPE';

  constructor() {
    super('A role assignment can be scoped to an org unit or a group, not both.');
  }
}
