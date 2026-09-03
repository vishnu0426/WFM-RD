import { DomainError } from '../../common/errors/domain-error';

export class RateLimitExhaustedError extends DomainError {
  constructor(provider: string, attempts: number) {
    super(
      'RATE_LIMIT_EXHAUSTED',
      `Provider "${provider}" kept returning a rate-limit response after ${attempts} retries - giving up for this sync.`,
    );
  }
}
