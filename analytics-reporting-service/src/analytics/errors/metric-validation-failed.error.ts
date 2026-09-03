import { DomainError } from '../../common/errors/domain-error';

/**
 * ADR-0110/§0.5/§2.3 rule 2: `createMetricDefinition`'s dry-run failed for
 * a `calculationDefinition` that *did* pass the structural whitelist check
 * (`MetricSourceNotAllowedError` covers the whitelist failure itself) - the
 * real query still errored for some other reason. Rejected outright, never
 * stored with `validatedAt: null` for someone to accidentally use later.
 */
export class MetricValidationFailedError extends DomainError {
  constructor(reason: string) {
    super('METRIC_VALIDATION_FAILED', `Metric definition failed its dry-run validation: ${reason}`);
  }
}

/**
 * §2.3 rule 2/ADR-0110: a dashboard widget may not reference a metric that
 * has never been validated - the identical posture as
 * `ExpensiveMetricNotAllowedOnWidgetError`, closing the gap Phase 4's own
 * guard left (nothing before Phase 5 could ever produce an unvalidated
 * row, so Phase 4 had no reason to check for one yet).
 */
export class UnvalidatedMetricNotAllowedOnWidgetError extends DomainError {
  constructor(metricName: string) {
    super(
      'UNVALIDATED_METRIC_NOT_ALLOWED_ON_WIDGET',
      `Metric "${metricName}" has not been validated yet and cannot back a live dashboard widget.`,
    );
  }
}

/** §2.1's own tenant-scoped uniqueness index (`idx_metric_definition_tenant_name`) - checked proactively, same pattern as every other create-path existence check in this service, rather than caught as a raw Postgres unique-violation error. */
export class MetricNameAlreadyExistsError extends DomainError {
  constructor(name: string) {
    super('METRIC_NAME_ALREADY_EXISTS', `A metric named "${name}" already exists for this tenant.`);
  }
}
