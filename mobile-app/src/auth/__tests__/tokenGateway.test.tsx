import { http, HttpResponse } from 'msw';

import { buildMockAccessToken, INITIAL_REFRESH_TOKEN } from '@/testing/mocks/handlers';
import { server } from '@/testing/mocks/server';

import { getValidAccessToken } from '../tokenGateway';
import { saveTokens } from '../tokenStorage';

describe('tokenGateway.getValidAccessToken', () => {
  it('returns the cached access token without refreshing when it is not near expiry', async () => {
    const accessToken = buildMockAccessToken();
    await saveTokens({
      accessToken,
      refreshToken: INITIAL_REFRESH_TOKEN,
      accessTokenExpiresAt: Date.now() + 10 * 60 * 1000,
    });

    let tokenRequestCount = 0;
    server.use(
      http.post('*/oauth/token', () => {
        tokenRequestCount += 1;
        return HttpResponse.json({ error: 'invalid_grant', error_description: 'should not be called' }, { status: 400 });
      }),
    );

    const result = await getValidAccessToken();

    expect(result).toBe(accessToken);
    expect(tokenRequestCount).toBe(0);
  });

  it('dedupes concurrent refreshes behind a single in-flight request', async () => {
    await saveTokens({
      accessToken: 'stale-access-token',
      refreshToken: INITIAL_REFRESH_TOKEN,
      accessTokenExpiresAt: Date.now() - 1000,
    });

    let tokenRequestCount = 0;
    const refreshedAccessToken = buildMockAccessToken();
    server.use(
      http.post('*/oauth/token', async ({ request }) => {
        tokenRequestCount += 1;
        const body = (await request.json()) as { grant_type?: string };
        expect(body.grant_type).toBe('refresh_token');
        return HttpResponse.json({
          access_token: refreshedAccessToken,
          token_type: 'Bearer',
          expires_in: 720,
          refresh_token: 'rotated-once',
          refresh_token_expires_in: 2_592_000,
          scope: '',
        });
      }),
    );

    const [tokenA, tokenB, tokenC] = await Promise.all([
      getValidAccessToken(),
      getValidAccessToken(),
      getValidAccessToken(),
    ]);

    // Refresh tokens are single-use/rotating server-side — a second
    // concurrent caller presenting the already-rotated token would trigger
    // the server's reuse-detection and revoke the whole family, so this
    // count staying at 1 is the actual regression guard, not just a nicety.
    expect(tokenRequestCount).toBe(1);
    expect(tokenA).toBe(refreshedAccessToken);
    expect(tokenB).toBe(refreshedAccessToken);
    expect(tokenC).toBe(refreshedAccessToken);
  });

  it('clears the session and rejects when the refresh token is rejected as invalid', async () => {
    await saveTokens({
      accessToken: 'stale-access-token',
      refreshToken: 'not-the-servers-valid-token',
      accessTokenExpiresAt: Date.now() - 1000,
    });

    await expect(getValidAccessToken()).rejects.toMatchObject({ error: 'invalid_grant' });

    // Session was cleared, not retried against the same dead token.
    await expect(getValidAccessToken()).rejects.toThrow('Not signed in.');
  });
});
