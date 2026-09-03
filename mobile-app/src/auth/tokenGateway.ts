import { refreshTokens as refreshTokensApi } from './authClient';
import { isRefreshInvalid } from './errors';
import { clearTokens, loadTokens, saveTokens, StoredTokens } from './tokenStorage';

/** Refresh this long before the access token's real expiry, so a proactive
 * refresh has time to land before any caller would otherwise hit a stale
 * token — matters because scheduling-service never returns 401 today
 * (docs/adr/0150), so a reactive-only strategy would have nothing to react
 * to from that particular caller. */
const REFRESH_SKEW_MS = 30_000;

let cachedTokens: StoredTokens | null = null;
let refreshPromise: Promise<StoredTokens> | null = null;

type SessionExpiredListener = () => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

export function getAuthApiBaseUrl(): string {
  const authApiBaseUrl = process.env.EXPO_PUBLIC_AUTH_API_BASE_URL;
  if (!authApiBaseUrl) {
    throw new Error('Missing EXPO_PUBLIC_AUTH_API_BASE_URL. Copy .env.example to .env.');
  }
  return authApiBaseUrl;
}

/** Subscribed once by AuthContext to move to the `unauthenticated` state
 * when a refresh is irrecoverably rejected (docs/adr/0150) — API callers
 * (apiGet, graphqlRequest) don't need to know about React state directly. */
export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

export async function setTokens(tokens: StoredTokens): Promise<void> {
  cachedTokens = tokens;
  await saveTokens(tokens);
}

export async function hydrateFromStorage(): Promise<StoredTokens | null> {
  cachedTokens = await loadTokens();
  return cachedTokens;
}

export async function clearSession(): Promise<void> {
  cachedTokens = null;
  refreshPromise = null;
  await clearTokens();
}

/** Test-only: reset in-memory state between tests within the same file —
 * this module is a singleton, so `cachedTokens`/`refreshPromise` otherwise
 * leak across `it()` blocks that don't go through `clearSession()`. */
export function __resetForTests(): void {
  cachedTokens = null;
  refreshPromise = null;
  sessionExpiredListeners.clear();
}

function isExpiringSoon(tokens: StoredTokens): boolean {
  return Date.now() >= tokens.accessTokenExpiresAt - REFRESH_SKEW_MS;
}

async function performRefresh(refreshToken: string): Promise<StoredTokens> {
  const response = await refreshTokensApi({ authApiBaseUrl: getAuthApiBaseUrl(), refreshToken });
  const next: StoredTokens = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    accessTokenExpiresAt: Date.now() + response.expires_in * 1000,
  };
  cachedTokens = next;
  await saveTokens(next);
  return next;
}

/**
 * The single chokepoint every authorized call (apiGet, graphqlRequest) must
 * go through — never call `authClient.refreshTokens()` directly. Dedupes
 * concurrent refreshes behind one in-flight promise: refresh tokens are
 * single-use and rotate, so two independent callers each refreshing
 * separately would have the second one present an already-rotated token,
 * triggering the server's reuse-detection and revoking the entire token
 * family (docs/adr/0150).
 */
export async function getValidAccessToken(): Promise<string> {
  if (!cachedTokens) {
    cachedTokens = await loadTokens();
  }
  if (!cachedTokens) {
    throw new Error('Not signed in.');
  }
  if (!isExpiringSoon(cachedTokens)) {
    return cachedTokens.accessToken;
  }

  if (!refreshPromise) {
    refreshPromise = performRefresh(cachedTokens.refreshToken).finally(() => {
      refreshPromise = null;
    });
  }

  try {
    const refreshed = await refreshPromise;
    return refreshed.accessToken;
  } catch (error) {
    if (isRefreshInvalid(error)) {
      await clearSession();
      sessionExpiredListeners.forEach((listener) => listener());
    }
    throw error;
  }
}
