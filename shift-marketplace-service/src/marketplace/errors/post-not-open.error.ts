import { DomainError } from '../../common/errors/domain-error';

/** The post exists but isn't in `open` status (already claimed/expired/cancelled) - distinct from the lock-loser fast-fail (`PostAlreadyBeingClaimedError`), which never gets far enough to read this. */
export class PostNotOpenError extends DomainError {
  constructor(postId: string, status: string) {
    super('POST_NOT_OPEN', `Marketplace post ${postId} is not open (status: ${status}).`);
  }
}
