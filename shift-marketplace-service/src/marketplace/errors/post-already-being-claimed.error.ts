import { DomainError } from '../../common/errors/domain-error';

/**
 * §4 step 3: the Redis lock's *loser* - an immediate, distinct "this shift
 * was just claimed" response, never a queue/wait on the winner's
 * validation. Deliberately a different error (and message) from
 * `PostNotOpenError`: this fires before any database read at all, purely
 * from losing the lock race, which is exactly the fast-fail UX §4/§0.5
 * require.
 */
export class PostAlreadyBeingClaimedError extends DomainError {
  constructor(postId: string) {
    super('POST_ALREADY_BEING_CLAIMED', `Marketplace post ${postId} was just claimed by someone else.`);
  }
}
