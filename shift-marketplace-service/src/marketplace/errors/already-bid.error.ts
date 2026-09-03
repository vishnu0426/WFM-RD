import { DomainError } from '../../common/errors/domain-error';

/** One bid per employee per opportunity (`bid_opportunity_employee_unique`, §5.1's own ranking having no meaning for duplicate bids from the same employee). */
export class AlreadyBidError extends DomainError {
  constructor(bidOpportunityId: string) {
    super('ALREADY_BID', `You have already submitted a bid for bid opportunity ${bidOpportunityId}.`);
  }
}
