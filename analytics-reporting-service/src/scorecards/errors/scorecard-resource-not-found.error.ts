import { DomainError } from '../../common/errors/domain-error';

/**
 * One parameterized error for all six Scorecards Sources entities rather
 * than six near-identical classes - proportionate to how similar the six
 * entities are (each a simple tenant-scoped catalog row), unlike
 * integration-hub-service's WP3 entities, which are structurally distinct
 * enough to warrant their own error types.
 */
export class ScorecardResourceNotFoundError extends DomainError {
  constructor(resourceType: string, id: string) {
    super('SCORECARD_RESOURCE_NOT_FOUND', `No ${resourceType} found with id "${id}" for this tenant.`);
  }
}
