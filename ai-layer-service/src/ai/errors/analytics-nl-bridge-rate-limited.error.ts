import { DomainError } from '../../common/errors/domain-error';

/**
 * ADR-0165: `NlAnalyticsBridgeService` reuses `AiInteractionRateLimiterService`
 * directly (the same `(tenantId, actorId)` token bucket ADR-0162's
 * `AiInteractionRateLimitGuard` already enforces for every other
 * `AIInteraction`-generating GraphQL mutation) - called here rather than
 * through that Guard because this path is entered from a gRPC controller,
 * not a GraphQL resolver, so no `CanActivate` pipeline runs before it. Same
 * limiter instance and key semantics, different enforcement point - a
 * disclosed deviation, not a second, drifting rate-limit implementation.
 */
export class AnalyticsNlBridgeRateLimitedError extends DomainError {
  constructor(public readonly retryAfterSeconds: number) {
    super('ANALYTICS_NL_BRIDGE_RATE_LIMITED', 'Too many analytics AI requests for this tenant. Try again later.');
  }
}
