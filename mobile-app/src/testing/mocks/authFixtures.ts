import { saveTokens } from '@/auth/tokenStorage';

import { buildMockAccessToken, INITIAL_REFRESH_TOKEN } from './handlers';

/**
 * Seeds the mocked secure store with a valid, non-expiring session so tests
 * for screens that require `useCurrentIdentity()`/`useAuth()` (i.e.
 * anything inside the authenticated (tabs) stack) don't have to drive the
 * whole sign-in UI just to reach `authenticated` status.
 */
export async function seedAuthenticatedSession(): Promise<void> {
  await saveTokens({
    accessToken: buildMockAccessToken(),
    refreshToken: INITIAL_REFRESH_TOKEN,
    accessTokenExpiresAt: Date.now() + 10 * 60 * 1000,
  });
}
