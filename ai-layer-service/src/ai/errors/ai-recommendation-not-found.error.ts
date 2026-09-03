import { DomainError } from '../../common/errors/domain-error';

export class AiRecommendationNotFoundError extends DomainError {
  constructor(recommendationId: string) {
    super(
      'AI_RECOMMENDATION_NOT_FOUND',
      `No AI recommendation with id "${recommendationId}" was found for this tenant.`,
    );
  }
}
