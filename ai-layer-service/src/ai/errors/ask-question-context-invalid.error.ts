import { DomainError } from '../../common/errors/domain-error';

/**
 * Thrown by `AskQuestionService` when the caller's `AskQuestionContext` does
 * not identify exactly one real resource. Per ADR-0111's own precedent
 * (Module 09's `NlQueryBridgeClient` gap) and non-negotiable #2, this module
 * has no capability to resolve a free-text question into a resource on its
 * own - the caller must supply an unambiguous pointer, and a request with
 * zero or more than one candidate source is a caller error, not something
 * to guess through.
 */
export class AskQuestionContextInvalidError extends DomainError {
  constructor(reason: string) {
    super('ASK_QUESTION_CONTEXT_INVALID', reason);
  }
}
