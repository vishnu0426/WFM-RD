import { DomainError } from '../../common/errors/domain-error';

/** An open swap (no `targetShiftId` named at proposal time) has nothing to trade until the accepting employee offers one. */
export class SwapOfferedShiftRequiredError extends DomainError {
  constructor(swapRequestId: string) {
    super(
      'SWAP_OFFERED_SHIFT_REQUIRED',
      `Swap request ${swapRequestId} is open - you must offer a shift to accept it.`,
    );
  }
}
