import { DomainError } from '../../common/errors/domain-error';

/** ADR-0165's own copy of `askQuestion`'s `MAX_QUESTION_LENGTH` guard (docs/adr/0133) - a real cost/DoS bound, checked before any gRPC or LLM cost is incurred. */
export class AnalyticsQuestionTooLongError extends DomainError {
  constructor(actualLength: number, maxLength: number) {
    super(
      'ANALYTICS_QUESTION_TOO_LONG',
      `question must be ${maxLength} characters or fewer (received ${actualLength}).`,
    );
  }
}
