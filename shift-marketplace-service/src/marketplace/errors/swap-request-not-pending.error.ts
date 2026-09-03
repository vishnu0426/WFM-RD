import { DomainError } from '../../common/errors/domain-error';

/** The swap exists but isn't `pending` (already accepted/rejected/cancelled/superseded). */
export class SwapRequestNotPendingError extends DomainError {
  constructor(swapRequestId: string, status: string) {
    super('SWAP_REQUEST_NOT_PENDING', `Swap request ${swapRequestId} is not pending (status: ${status}).`);
  }
}
