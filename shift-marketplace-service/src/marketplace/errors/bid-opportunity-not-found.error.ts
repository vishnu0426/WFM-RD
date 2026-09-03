import { DomainError } from '../../common/errors/domain-error';

export class BidOpportunityNotFoundError extends DomainError {
  constructor(bidOpportunityId: string) {
    super('BID_OPPORTUNITY_NOT_FOUND', `Bid opportunity ${bidOpportunityId} was not found.`);
  }
}
