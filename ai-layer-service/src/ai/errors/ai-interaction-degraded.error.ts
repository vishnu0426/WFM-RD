import { DomainError } from '../../common/errors/domain-error';

/** Non-negotiable #2: a recommendation's `rationale_text` must be a real LLM output - a degraded (`output_text: null`) interaction has nothing to build one from. */
export class AiInteractionDegradedError extends DomainError {
  constructor(aiInteractionId: string) {
    super(
      'AI_INTERACTION_DEGRADED',
      `AIInteraction "${aiInteractionId}" was served in degraded mode and has no real rationale to build a recommendation from.`,
    );
  }
}
