import { DomainError } from '../../common/errors/domain-error';

export class BidOpportunityAlreadyClosedError extends DomainError {
  constructor(bidOpportunityId: string) {
    super('BID_OPPORTUNITY_ALREADY_CLOSED', `Bid opportunity ${bidOpportunityId} has already been closed and ranked.`);
  }
}
