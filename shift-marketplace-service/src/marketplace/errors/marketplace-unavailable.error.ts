import { DomainError } from '../../common/errors/domain-error';

/**
 * §0.5's Redis chaos scenario: if the distributed lock can't be acquired
 * because Redis itself is unreachable, the correct behavior is a clear
 * "marketplace temporarily unavailable" rejection, never a silent fallback
 * to an unlocked DB write - that would reintroduce the exact race condition
 * this module exists to prevent.
 */
export class MarketplaceUnavailableError extends DomainError {
  constructor() {
    super('MARKETPLACE_UNAVAILABLE', 'The marketplace is temporarily unavailable - please retry shortly.');
  }
}
