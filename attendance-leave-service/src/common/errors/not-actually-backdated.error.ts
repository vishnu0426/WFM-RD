import { DomainError } from './domain-error';

/** §5.1's stricter path is only for genuinely past-dated entries - the mirror image of `BackdatedLeaveNotSupportedError` (Phase 3), which rejects a past date on the *ordinary* `requestLeave` path. A `submitBackdatedLeave` call with a present/future `dateRangeStart` is rejected the same way, directing the caller back to `requestLeave` - the two mutations' input domains are disjoint by construction, never overlapping. */
export class NotActuallyBackdatedError extends DomainError {
  constructor() {
    super(
      'NOT_ACTUALLY_BACKDATED',
      'dateRangeStart is not in the past - use requestLeave instead of submitBackdatedLeave.',
    );
  }
}
