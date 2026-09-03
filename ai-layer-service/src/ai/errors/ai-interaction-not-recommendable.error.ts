import { DomainError } from '../../common/errors/domain-error';

/** Phase 5 scope decision (docs/adr/0123): only `reallocation_rationale` interactions can become an `AIRecommendation` today - it's the only source_module with a real, governed execution pathway wired. */
export class AiInteractionNotRecommendableError extends DomainError {
  constructor(interactionType: string) {
    super(
      'AI_INTERACTION_NOT_RECOMMENDABLE',
      `AIInteraction of type "${interactionType}" cannot be turned into an AIRecommendation yet - only "reallocation_rationale" has a real execution pathway wired.`,
    );
  }
}
