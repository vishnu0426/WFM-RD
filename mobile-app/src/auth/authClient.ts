import { OAuthApiError } from './errors';

/** docs/adr/0150 — seeded once via src/database/seeds/run-seed.ts, scoped
 * to the demo tenant. Never a runtime-registered client (that would
 * require OAUTH_CLIENT_REGISTRATION_TOKEN, an operator-only secret the app
 * must never hold). */
export const OAUTH_CLIENT_ID = 'wfm-mobile-app';
/** Never actually redirected to — POST /oauth/authorize returns the code
 * directly in its JSON response body (ADR-0026) — but still exact-string
 * validated against the client's registered redirectUris. */
export const OAUTH_REDIRECT_URI = 'agnowfm://oauth/callback';

interface AuthorizeResponse {
  code: string;
  state: string | null;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in?: number;
  scope: string;
  id_token?: string;
}

async function postJson<T>(baseUrl: string, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await response.json();

  if (!response.ok) {
    throw new OAuthApiError(json.error ?? 'unknown_error', json.error_description ?? response.statusText);
  }

  return json as T;
}

export async function authorizeWithPassword(params: {
  authApiBaseUrl: string;
  username: string;
  password: string;
  codeChallenge: string;
}): Promise<AuthorizeResponse> {
  return postJson<AuthorizeResponse>(params.authApiBaseUrl, '/oauth/authorize', {
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: 'code',
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    username: params.username,
    password: params.password,
  });
}

export async function exchangeCodeForTokens(params: {
  authApiBaseUrl: string;
  code: string;
  codeVerifier: string;
}): Promise<TokenResponse> {
  return postJson<TokenResponse>(params.authApiBaseUrl, '/oauth/token', {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: OAUTH_REDIRECT_URI,
    code_verifier: params.codeVerifier,
    client_id: OAUTH_CLIENT_ID,
  });
}

export async function refreshTokens(params: {
  authApiBaseUrl: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  return postJson<TokenResponse>(params.authApiBaseUrl, '/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
}
