import { DomainError } from '../../common/errors/domain-error';

/** Shared by `approveMarketplaceAction`'s claim and swap paths - the referenced action exists but isn't sitting in `pending_approval` (already approved/rejected, or never reached that state at all). */
export class ActionNotPendingApprovalError extends DomainError {
  constructor(actionId: string, status: string) {
    super('ACTION_NOT_PENDING_APPROVAL', `Marketplace action ${actionId} is not pending approval (status: ${status}).`);
  }
}
