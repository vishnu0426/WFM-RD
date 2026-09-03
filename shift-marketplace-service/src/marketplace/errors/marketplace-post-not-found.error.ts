import { DomainError } from '../../common/errors/domain-error';

export class MarketplacePostNotFoundError extends DomainError {
  constructor(postId: string) {
    super('MARKETPLACE_POST_NOT_FOUND', `Marketplace post ${postId} was not found.`);
  }
}
