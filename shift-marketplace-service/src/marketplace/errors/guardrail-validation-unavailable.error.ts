import { DomainError } from '../../common/errors/domain-error';

/**
 * §0.5's guardrail-gRPC chaos scenario: if Module 04's
 * `SchedulingEligibilityService` can't be reached (or times out,
 * `SchedulingEligibilityGrpcClientService`'s own `CALL_TIMEOUT_MS`), the
 * claim must fail closed - a clear, retryable error, with the lock already
 * released - never proceed to approval without a real validation result.
 */
export class GuardrailValidationUnavailableError extends DomainError {
  constructor() {
    super(
      'GUARDRAIL_VALIDATION_UNAVAILABLE',
      'Guardrail validation is temporarily unavailable - please retry shortly.',
    );
  }
}
