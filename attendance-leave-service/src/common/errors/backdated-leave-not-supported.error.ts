import { DomainError } from './domain-error';

/**
 * §5.1: `requestLeave` is not the path for a `date_range_start` in the
 * past - that is `submitBackdatedLeave`'s stricter, elevated-permission
 * path specifically so this can't be silently bypassed (§3.1's own
 * wording: a separate mutation, not an overload, "so the stricter audit
 * path can't be accidentally skipped"). `submitBackdatedLeave` has shipped
 * since Phase 6 - a backdated submission via this endpoint is rejected
 * outright and redirected there, never silently accepted with
 * `is_backdated: true`.
 */
export class BackdatedLeaveNotSupportedError extends DomainError {
  constructor() {
    super(
      'BACKDATED_LEAVE_NOT_SUPPORTED',
      'date_range_start is in the past - requestLeave does not accept backdated submissions. ' +
        'Use submitBackdatedLeave (POST /v1/leave/backdated-requests) instead.',
    );
  }
}
