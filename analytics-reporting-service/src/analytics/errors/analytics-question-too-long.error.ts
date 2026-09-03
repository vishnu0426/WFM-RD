import { DomainError } from '../../common/errors/domain-error';

/** ADR-0165: Module 10's `NlQueryBridgeService` responded `errorCode: "QUESTION_TOO_LONG"` (its own 4,000-character guardrail, docs/adr/0133's own precedent). */
export class AnalyticsQuestionTooLongError extends DomainError {
  constructor() {
    super('ANALYTICS_QUESTION_TOO_LONG', 'question must be 4000 characters or fewer.');
  }
}
