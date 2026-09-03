import { DomainError } from '../../common/errors/domain-error';

/** §5a: the real degradation signal a relay's backpressure guard reacts to - Module 05's own `UpstreamUnavailableError` surfaces as this HTTP 503. */
export class IntradayUpstreamDegradedError extends DomainError {
  constructor(cause: string) {
    super('INTRADAY_UPSTREAM_DEGRADED', `Module 05's activity-events endpoint signaled degradation: ${cause}`);
  }
}

/** A genuine forward failure (e.g. Module 05 rejected the event body) - not a degradation signal, does not engage backpressure. */
export class IntradayForwardFailedError extends DomainError {
  constructor(cause: string) {
    super('INTRADAY_FORWARD_FAILED', `Forwarding to Module 05's activity-events endpoint failed: ${cause}`);
  }
}

export class IntradayHmacSecretNotConfiguredError extends DomainError {
  constructor(tenantId: string) {
    super(
      'INTRADAY_HMAC_SECRET_NOT_CONFIGURED',
      `No INTRADAY_INGESTION_HMAC_SECRETS entry for tenant "${tenantId}" - cannot sign a request Module 05 will accept.`,
    );
  }
}
