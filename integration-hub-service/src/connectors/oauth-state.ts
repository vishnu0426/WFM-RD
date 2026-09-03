import { randomBytes } from 'crypto';

/**
 * The `state` parameter serves its standard OAuth CSRF-protection role
 * *and* is this endpoint's only way to identify which pending connector a
 * callback belongs to - a provider-initiated redirect carries no tenant
 * header (ADR-0137). Encoding `tenantId`/`connectorId` into `state` lets
 * `POST /v1/integrations/oauth/callback` (called by Agno's own frontend
 * after it intercepts the provider's redirect, itself an authenticated
 * call carrying a real tenant header/JWT) resolve the right connector
 * without a client-supplied `connectorId` argument, while the embedded
 * `nonce` is still what actually authenticates the callback - a forged
 * `state` with a real-looking `tenantId.connectorId` but a wrong `nonce`
 * fails `completeOAuthCallback`'s equality check against the value stored
 * on the connector row at creation time, identically to today's mismatch
 * check.
 */
export function generateOAuthState(tenantId: string, connectorId: string): string {
  const nonce = randomBytes(24).toString('hex');
  return `${tenantId}.${connectorId}.${nonce}`;
}

export interface ParsedOAuthState {
  tenantId: string;
  connectorId: string;
}

/** Returns `null` for a malformed state rather than throwing - the caller (`completeOAuthCallback`) turns that into the same `OAuthStateMismatchError` a real mismatch produces, so a forged state can't be distinguished from a malformed one. */
export function parseOAuthState(state: string): ParsedOAuthState | null {
  const parts = state.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return null;
  }
  return { tenantId: parts[0], connectorId: parts[1] };
}
