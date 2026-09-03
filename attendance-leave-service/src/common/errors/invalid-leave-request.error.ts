import { DomainError } from './domain-error';

/** Basic input-shape problems (e.g. date_range_end before date_range_start) - checked before any external call is made. */
export class InvalidLeaveRequestError extends DomainError {
  constructor(reason: string) {
    super('INVALID_LEAVE_REQUEST', reason);
  }
}
