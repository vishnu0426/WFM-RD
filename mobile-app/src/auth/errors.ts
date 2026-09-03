/** Matches `oauth-error.filter.ts`'s RFC 6749-style response shape —
 * NOT this platform's usual `{error:{code,message,details}}` envelope. */
export class OAuthApiError extends Error {
  constructor(
    public readonly error: string,
    public readonly errorDescription: string,
  ) {
    super(errorDescription);
    this.name = 'OAuthApiError';
  }
}

/**
 * `InvalidCredentialsError` (bad username/password) and `AccountLockedError`
 * both serialize to the identical `{error: 'invalid_grant'}` — there is no
 * machine-readable field to tell them apart, only a free-text
 * `error_description` (confirmed by reading both error classes server-side).
 * String-matching that text would be a brittle, silently-breaking parse if
 * the backend's wording ever changes, so this deliberately shows one
 * generic message for every `invalid_grant` on sign-in (docs/adr/0150).
 */
export function mapSignInErrorToMessage(error: OAuthApiError): string {
  if (error.error === 'invalid_grant') {
    return 'Incorrect username or password.';
  }
  return "Couldn't sign in. Please try again.";
}

/**
 * A refresh failure is always `invalid_grant`, whether the token merely
 * expired or was reused after rotation (family-wide revocation) — the
 * server deliberately makes these indistinguishable to avoid leaking
 * reuse-detection to a possible attacker. The only correct client response
 * to ANY refresh failure is: discard local tokens, return to sign-in.
 */
export function isRefreshInvalid(error: unknown): error is OAuthApiError {
  return error instanceof OAuthApiError && error.error === 'invalid_grant';
}
