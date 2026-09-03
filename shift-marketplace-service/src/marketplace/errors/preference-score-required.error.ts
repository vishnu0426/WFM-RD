import { DomainError } from '../../common/errors/domain-error';

export class PreferenceScoreRequiredError extends DomainError {
  constructor(bidOpportunityId: string) {
    super(
      'PREFERENCE_SCORE_REQUIRED',
      `Bid opportunity ${bidOpportunityId} ranks by preference score - you must submit one to bid.`,
    );
  }
}
