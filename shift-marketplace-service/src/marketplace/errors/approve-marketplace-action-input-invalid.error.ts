import { DomainError } from '../../common/errors/domain-error';

/** `approveMarketplaceAction` takes exactly one of `claimId`/`swapRequestId` - claims and swaps are different entities with different approval semantics, and this mutation needs to know which one it's approving. */
export class ApproveMarketplaceActionInputInvalidError extends DomainError {
  constructor() {
    super('APPROVE_MARKETPLACE_ACTION_INPUT_INVALID', 'Exactly one of claimId or swapRequestId must be provided.');
  }
}
