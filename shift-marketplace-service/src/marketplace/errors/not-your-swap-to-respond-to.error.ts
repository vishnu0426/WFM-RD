import { DomainError } from '../../common/errors/domain-error';

/** A closed swap (`targetEmployeeId` already named) may only be responded to by that named employee. */
export class NotYourSwapToRespondToError extends DomainError {
  constructor(swapRequestId: string) {
    super('NOT_YOUR_SWAP_TO_RESPOND_TO', `Swap request ${swapRequestId} was not proposed to you.`);
  }
}
