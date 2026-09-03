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
 * §5.1's explicit assertion step - this module's own security-specific
 * error, no precedent in any other service. Thrown by
 * `TenantScopeAssertionService.assertSameTenant` when a gRPC response
 * assembled into `input_context` carries a `tenant_id` that doesn't match
 * the requesting user's own bound tenant context - logged as a
 * security-relevant event (§0.5's on-call table: "page accordingly"), not a
 * routine 4xx.
 */
export class CrossTenantDataAssemblyError extends DomainError {
  constructor(sourceModule: string) {
    super(
      'CROSS_TENANT_DATA_ASSEMBLY_DETECTED',
      `Data assembled from ${sourceModule} did not match the requesting tenant - request rejected before any LLM call was made.`,
    );
  }
}
