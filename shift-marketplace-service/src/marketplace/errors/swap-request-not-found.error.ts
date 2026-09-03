import { DomainError } from '../../common/errors/domain-error';

export class SwapRequestNotFoundError extends DomainError {
  constructor(swapRequestId: string) {
    super('SWAP_REQUEST_NOT_FOUND', `Swap request ${swapRequestId} was not found.`);
  }
}
