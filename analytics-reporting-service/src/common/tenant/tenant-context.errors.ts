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

/**
 * Phase 4 (ADR-0084's pattern, own copy per ADR-0039): only
 * `createDashboard`/`myDashboards` require actor identity (to populate/
 * filter `SavedReport.createdBy`) - most of this module's read paths
 * (`metricQuery`, the REST BI connector) need only a tenant.
 */
export class ActorContextMissingError extends DomainError {
  constructor() {
    super('ACTOR_CONTEXT_MISSING', 'No actor context is bound to this request.');
  }
}
