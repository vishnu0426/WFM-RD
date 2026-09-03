import { DomainError } from '../../common/errors/domain-error';

export class MetricNotFoundError extends DomainError {
  constructor(name: string) {
    super('METRIC_NOT_FOUND', `No MetricDefinition named "${name}" is visible to this tenant.`);
  }
}

/**
 * Defensive - should never trigger for this module's own seeded platform-
 * default metrics. Exists because `MetricQueryEngineService` validates
 * `calculationDefinition.sourceView`/`valueColumn` against its own
 * hardcoded whitelist before building any SQL, never trusting the jsonb
 * blindly - the same boundary Phase 5's tenant-authored dry-run gate will
 * also need.
 */
export class MetricSourceNotAllowedError extends DomainError {
  constructor(metricName: string) {
    super(
      'METRIC_SOURCE_NOT_ALLOWED',
      `MetricDefinition "${metricName}" has a calculation_definition this query engine does not recognize as a valid source.`,
    );
  }
}
