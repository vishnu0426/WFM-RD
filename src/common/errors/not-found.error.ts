import { DomainError } from './domain-error';

/**
 * Shared base for "no row matched this id, within the caller's tenant
 * scope" - deliberately doesn't distinguish "doesn't exist" from "exists in
 * another tenant" in its message, since RLS already makes those
 * indistinguishable at the data layer (a cross-tenant read returns zero
 * rows, not a permission error) and the HTTP/GraphQL surface shouldn't leak
 * the difference either.
 */
export abstract class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';

  protected constructor(resourceType: string, id: string) {
    super(`${resourceType} ${id} was not found.`, { resourceType, id });
  }
}
