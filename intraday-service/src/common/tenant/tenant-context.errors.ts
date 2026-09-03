import { DomainError } from '../errors/domain-error';

export class TenantContextMissingError extends DomainError {
  readonly code = 'TENANT_CONTEXT_MISSING';

  constructor() {
    super('No tenant context bound for this request - missing or invalid X-Tenant-Id header.');
  }
}

export class InvalidTenantIdError extends DomainError {
  readonly code = 'INVALID_TENANT_ID';

  constructor(tenantId: string) {
    super(`Invalid tenant id: ${tenantId}`);
  }
}

/** Phase 5: `acknowledgeAlert` needs to know who acknowledged - see `TenantContextService.requireActorId()`. */
export class ActorContextMissingError extends DomainError {
  readonly code = 'ACTOR_CONTEXT_MISSING';

  constructor() {
    super('No actor context bound for this request - missing X-Actor-Id header.');
  }
}
