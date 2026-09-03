import { DomainError } from '../errors/domain-error';

export class TenantContextMissingError extends DomainError {
  constructor() {
    super('TENANT_CONTEXT_MISSING', 'No tenant context is bound to this request.');
  }
}

export class InvalidTenantIdError extends DomainError {
  constructor(tenantId: string) {
    super('INVALID_TENANT_ID', `"${tenantId}" is not a valid tenant id.`);
  }
}

/** Phase 2 (ADR-0084): `claimOpenShift` needs to know who is claiming - see `TenantContextService.requireActorId()`. */
export class ActorContextMissingError extends DomainError {
  constructor() {
    super('ACTOR_CONTEXT_MISSING', 'No actor context is bound to this request - missing X-Actor-Id header.');
  }
}
