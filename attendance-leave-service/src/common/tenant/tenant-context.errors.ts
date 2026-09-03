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
