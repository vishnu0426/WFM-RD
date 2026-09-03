import { DomainError } from '../../common/errors/domain-error';

export class MarketplaceClaimNotFoundError extends DomainError {
  constructor(claimId: string) {
    super('MARKETPLACE_CLAIM_NOT_FOUND', `Marketplace claim ${claimId} was not found.`);
  }
}
