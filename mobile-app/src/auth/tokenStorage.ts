import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Native Keychain (iOS) / Keystore (Android) via expo-secure-store — the
 * "encrypted local device storage" the source spec requires for anything
 * containing auth tokens, never AsyncStorage.
 *
 * expo-secure-store has NO web implementation at all (its native module is
 * an empty stub there — confirmed by reading `ExpoSecureStore.web.js`), so
 * calling it under `npm run web` throws. Web stays a dev-only target with
 * no EAS build profile (Phase 1's `eas.json`), so this falls back to
 * `localStorage` there — explicitly NOT secure, only acceptable because a
 * production build can never target web.
 */
const isWeb = Platform.OS === 'web';

const ACCESS_TOKEN_KEY = 'agno_wfm_access_token';
const REFRESH_TOKEN_KEY = 'agno_wfm_refresh_token';
const ACCESS_TOKEN_EXPIRES_AT_KEY = 'agno_wfm_access_token_expires_at';

async function setItem(key: string, value: string): Promise<void> {
  if (isWeb) {
    globalThis.localStorage?.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function getItem(key: string): Promise<string | null> {
  if (isWeb) {
    return globalThis.localStorage?.getItem(key) ?? null;
  }
  return SecureStore.getItemAsync(key);
}

async function deleteItem(key: string): Promise<void> {
  if (isWeb) {
    globalThis.localStorage?.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix ms. */
  accessTokenExpiresAt: number;
}

export async function saveTokens(tokens: StoredTokens): Promise<void> {
  await Promise.all([
    setItem(ACCESS_TOKEN_KEY, tokens.accessToken),
    setItem(REFRESH_TOKEN_KEY, tokens.refreshToken),
    setItem(ACCESS_TOKEN_EXPIRES_AT_KEY, String(tokens.accessTokenExpiresAt)),
  ]);
}

export async function loadTokens(): Promise<StoredTokens | null> {
  const [accessToken, refreshToken, accessTokenExpiresAtRaw] = await Promise.all([
    getItem(ACCESS_TOKEN_KEY),
    getItem(REFRESH_TOKEN_KEY),
    getItem(ACCESS_TOKEN_EXPIRES_AT_KEY),
  ]);
  if (!accessToken || !refreshToken || !accessTokenExpiresAtRaw) {
    return null;
  }
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: Number(accessTokenExpiresAtRaw),
  };
}

export async function clearTokens(): Promise<void> {
  await Promise.all([
    deleteItem(ACCESS_TOKEN_KEY),
    deleteItem(REFRESH_TOKEN_KEY),
    deleteItem(ACCESS_TOKEN_EXPIRES_AT_KEY),
  ]);
}
