import { DomainError } from './domain-error';

/** Thrown by `HmacSignatureGuard` on a missing/malformed header, a bad HMAC, or a `t=` outside the tolerance window. */
export class InvalidSignatureError extends DomainError {
  readonly code = 'INVALID_SIGNATURE';

  constructor(reason: string) {
    super(`Webhook signature verification failed: ${reason}`);
  }
}
