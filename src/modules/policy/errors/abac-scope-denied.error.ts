import { DomainError } from '../../../common/errors/domain-error';

/**
 * §3.1's ABAC requirement (e.g. "Site Supervisor scoped to their org-unit
 * subtree"), the enforcement half `AbacService` provides. Distinct from
 * `PermissionsGuard`'s RBAC-only `ForbiddenException`: this means "you hold
 * the permission, but not for this specific org unit," a more precise
 * failure than a blanket 403 with no explanation.
 */
export class AbacScopeDeniedError extends DomainError {
  readonly code = 'ABAC_SCOPE_DENIED';

  /**
   * `scopeKind` fixes a real pre-existing bug found while adding
   * `assertPermittedForEmployee`: every caller (including the pre-existing
   * `assertPermittedForGroup`) previously always said "for org unit X" in
   * the message, even when `X` was actually a group id or an employee id -
   * misleading, since it's the one detail an admin actually needs to
   * self-diagnose a scope denial without reading server logs.
   */
  constructor(resource: string, action: string, targetId: string | null, scopeKind: 'org unit' | 'group' | 'employee' = 'org unit') {
    super(
      `Caller does not hold "${resource}:${action}" for ${targetId ? `${scopeKind} ${targetId}` : 'this tenant-wide resource'}.`,
      { resource, action, targetId, scopeKind },
    );
  }
}
