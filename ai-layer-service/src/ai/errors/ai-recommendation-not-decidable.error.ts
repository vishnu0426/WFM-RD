import { DomainError } from '../../common/errors/domain-error';

/** Thrown by `decideRecommendation` when the recommendation is not in `status: 'suggested'` - already decided (or auto-executed) once, never twice. */
export class AiRecommendationNotDecidableError extends DomainError {
  constructor(recommendationId: string, currentStatus: string) {
    super(
      'AI_RECOMMENDATION_NOT_DECIDABLE',
      `AI recommendation "${recommendationId}" is not awaiting a decision (status: "${currentStatus}").`,
    );
  }
}
