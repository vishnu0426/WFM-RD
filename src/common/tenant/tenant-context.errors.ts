import { DomainError } from '../errors/domain-error';

/** Thrown by TenantScopedRepository when no tenant context is bound. Fail closed. */
export class TenantContextMissingError extends DomainError {
  readonly code = 'TENANT_CONTEXT_MISSING';

  constructor() {
    super(
      'No tenant context is bound for this operation; refusing to run an unscoped query against a tenant-scoped table.',
    );
  }
}

/** Thrown when an entity's tenant_id conflicts with the bound tenant context. */
export class TenantMismatchError extends DomainError {
  readonly code = 'TENANT_MISMATCH';

  constructor(expectedTenantId: string, actualTenantId: string | null | undefined) {
    super(
      `Entity tenant_id (${actualTenantId ?? 'null'}) does not match the bound tenant context (${expectedTenantId}).`,
      { expectedTenantId, actualTenantId: actualTenantId ?? null },
    );
  }
}

/** Thrown when TenantContextService.run() is given a value that isn't a well-formed UUID. */
export class InvalidTenantIdError extends DomainError {
  readonly code = 'INVALID_TENANT_ID';

  constructor(value: string) {
    super(`"${value}" is not a valid UUID and cannot be bound as a tenant context.`, { value });
  }
}
