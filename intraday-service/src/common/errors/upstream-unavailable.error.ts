import { DomainError } from './domain-error';

/**
 * ADR-0062's fail-visible posture surfaced as an HTTP error: thrown by
 * `IngestionService` when `IntradayRedisService`'s idempotency lock or
 * `IntradayNatsClientService.publish` fails. Mapped to `503` by
 * `DomainErrorFilter` - the calling ACD/CCaaS system is already expected to
 * retry a non-2xx webhook delivery, so this is a legitimate, expected
 * response, not a crash.
 */
export class UpstreamUnavailableError extends DomainError {
  readonly code = 'UPSTREAM_UNAVAILABLE';

  constructor(upstream: 'redis' | 'nats', cause: unknown) {
    super(`${upstream} unavailable: ${(cause as Error).message}`);
  }
}
