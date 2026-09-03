import { DomainError } from '../../common/errors/domain-error';

export class BiddingWindowNotOpenError extends DomainError {
  constructor(bidOpportunityId: string, reason: 'not_yet_open' | 'closed') {
    super(
      'BIDDING_WINDOW_NOT_OPEN',
      `Bid opportunity ${bidOpportunityId}'s bidding window is ${reason === 'not_yet_open' ? 'not open yet' : 'already closed'}.`,
    );
  }
}
