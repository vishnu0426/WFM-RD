import { DomainError } from '../../../common/errors/domain-error';

/**
 * `ErasureRequest.requested_by` FKs to `core.users` and is part of the
 * compliance record itself (§2.4) - unlike most of this module's writes,
 * it cannot silently fall back to a system/nil actor. Same placeholder
 * posture as the rest of this module (ADR-0014): a real deployment
 * authenticates the caller and always has a validated `X-Actor-Id`; this
 * surfaces as a clean 400 rather than a raw FK-violation 500 when it's
 * missing.
 */
export class ErasureRequestActorRequiredError extends DomainError {
  readonly code = 'ERASURE_REQUEST_ACTOR_REQUIRED';

  constructor() {
    super('Creating an erasure request requires an authenticated actor (X-Actor-Id).');
  }
}
