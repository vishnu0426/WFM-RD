import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { authorizeWithPassword, exchangeCodeForTokens } from './authClient';
import { authenticateWithBiometrics, isBiometricUnlockEnabled } from './biometric';
import { AccessTokenClaims, decodeAccessTokenClaims } from './jwt';
import { computeCodeChallenge, generateCodeVerifier } from './pkce';
import {
  getAuthApiBaseUrl,
  getValidAccessToken,
  hydrateFromStorage,
  onSessionExpired,
  clearSession as clearTokenGatewaySession,
  setTokens as setTokenGatewayTokens,
} from './tokenGateway';

export type AuthStatus = 'bootstrapping' | 'unauthenticated' | 'locked' | 'authenticated';

interface AuthContextValue {
  status: AuthStatus;
  claims: AccessTokenClaims | null;
  signIn(username: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** Returns whether the unlock succeeded, rather than throwing, so
   * app/unlock.tsx can show a retry affordance on a plain biometric
   * failure/cancel without treating it as an app-level error. */
  unlockWithBiometric(): Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function establishAuthenticatedSession(tokens: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}): Promise<AccessTokenClaims> {
  await setTokenGatewayTokens({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
  });
  return decodeAccessTokenClaims(tokens.access_token);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('bootstrapping');
  const [claims, setClaims] = useState<AccessTokenClaims | null>(null);

  useEffect(() => {
    return onSessionExpired(() => {
      setClaims(null);
      setStatus('unauthenticated');
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const storedTokens = await hydrateFromStorage();
      if (!storedTokens) {
        if (!cancelled) setStatus('unauthenticated');
        return;
      }

      if (await isBiometricUnlockEnabled()) {
        if (!cancelled) {
          setClaims(decodeAccessTokenClaims(storedTokens.accessToken));
          setStatus('locked');
        }
        return;
      }

      try {
        const accessToken = await getValidAccessToken();
        if (!cancelled) {
          setClaims(decodeAccessTokenClaims(accessToken));
          setStatus('authenticated');
        }
      } catch {
        if (!cancelled) setStatus('unauthenticated');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    const authApiBaseUrl = getAuthApiBaseUrl();
    const codeVerifier = await generateCodeVerifier();
    const codeChallenge = await computeCodeChallenge(codeVerifier);

    const { code } = await authorizeWithPassword({ authApiBaseUrl, username, password, codeChallenge });
    const tokens = await exchangeCodeForTokens({ authApiBaseUrl, code, codeVerifier });

    const nextClaims = await establishAuthenticatedSession(tokens);
    setClaims(nextClaims);
    setStatus('authenticated');
  }, []);

  const signOut = useCallback(async () => {
    await clearTokenGatewaySession();
    setClaims(null);
    setStatus('unauthenticated');
  }, []);

  const unlockWithBiometric = useCallback(async () => {
    const success = await authenticateWithBiometrics();
    if (!success) {
      return false;
    }

    try {
      const accessToken = await getValidAccessToken();
      setClaims(decodeAccessTokenClaims(accessToken));
      setStatus('authenticated');
      return true;
    } catch {
      // Local biometric check passed, but the session itself is no longer
      // valid server-side (refresh failed) — onSessionExpired above already
      // moved status to 'unauthenticated' in that case.
      return false;
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, claims, signIn, signOut, unlockWithBiometric }),
    [status, claims, signIn, signOut, unlockWithBiometric],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth() must be called within an AuthProvider.');
  }
  return context;
}
