import { DomainError } from '../../../common/errors/domain-error';
import { ErasureRequestStatus } from '../entities/erasure-request-status.enum';

/** `pending -> approved|rejected`, `approved -> completed|rejected` only - any other requested transition is rejected here, not silently coerced. */
export class ErasureRequestInvalidTransitionError extends DomainError {
  readonly code = 'INVALID_STATE_TRANSITION';

  constructor(id: string, from: ErasureRequestStatus, to: ErasureRequestStatus) {
    super(`ErasureRequest ${id} cannot transition from '${from}' to '${to}'.`, { id, from, to });
  }
}
