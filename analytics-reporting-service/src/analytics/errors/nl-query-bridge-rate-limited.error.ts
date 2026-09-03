import { DomainError } from '../../common/errors/domain-error';

/** ADR-0165: Module 10's `NlQueryBridgeService` responded `errorCode: "RATE_LIMITED"` - this tenant/actor has hit `AiInteractionRateLimiterService`'s own token bucket (ADR-0162). */
export class NlQueryBridgeRateLimitedError extends DomainError {
  constructor(public readonly retryAfterSeconds: number) {
    super('NL_QUERY_BRIDGE_RATE_LIMITED', 'Too many analytics AI requests. Try again later.');
  }
}
