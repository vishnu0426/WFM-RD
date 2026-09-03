import { DomainError } from '../../common/errors/domain-error';

/**
 * The open-swap-accept analogue of `PostAlreadyBeingClaimedError` (§4 step
 * 3's fast-fail UX) - two employees racing to accept the same open swap is
 * the same "exactly one concurrent winner" race the claim lock protects
 * against, just on `SwapRequest` instead of `MarketplacePost`.
 */
export class SwapAlreadyBeingRespondedToError extends DomainError {
  constructor(swapRequestId: string) {
    super('SWAP_ALREADY_BEING_RESPONDED_TO', `Swap request ${swapRequestId} was just accepted by someone else.`);
  }
}
