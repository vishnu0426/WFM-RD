/**
 * Shared OAuth2 client_credentials token fetch, used by every real
 * vendor-specific `HistoricalConnectorAdapter` below (Genesys Cloud, Avaya
 * Experience Platform, Talkdesk, NICE CXone) - all four use this exact
 * grant type for server-to-server API access per their own real,
 * publicly documented auth flows (see each adapter's own doc comment for
 * its specific token endpoint and source). Not shared with Five9, which
 * uses SOAP + HTTP Basic Auth instead (see five9-historical.adapter.ts).
 */
export interface OAuth2Token {
  accessToken: string;
  expiresInSeconds: number;
}

export async function fetchClientCredentialsToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  extraParams?: Record<string, string>,
): Promise<OAuth2Token> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    ...(extraParams ?? {}),
  });
  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      // Fails closed on an unreachable/slow token host rather than hanging
      // indefinitely - found live during implementation (a fake-credential
      // test against a real vendor host stayed "running" well past a
      // reasonable timeout with no explicit deadline set).
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`OAuth2 token request to ${tokenUrl} failed: ${(err as Error).message}`);
  }
  if (!response.ok) {
    throw new Error(`OAuth2 token request to ${tokenUrl} failed: HTTP ${response.status}: ${await safeText(response)}`);
  }
  const json = (await response.json()) as { access_token: string; expires_in?: number };
  return { accessToken: json.access_token, expiresInSeconds: json.expires_in ?? 3600 };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}
