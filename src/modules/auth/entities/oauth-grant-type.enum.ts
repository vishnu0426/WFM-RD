/**
 * §5.1's supported grants for this phase. Device Authorization Flow is
 * explicitly deferred (see docs/phase-2-design-doc.md's out-of-scope list).
 */
export enum OAuthGrantType {
  AUTHORIZATION_CODE = 'authorization_code',
  REFRESH_TOKEN = 'refresh_token',
  CLIENT_CREDENTIALS = 'client_credentials',
}
