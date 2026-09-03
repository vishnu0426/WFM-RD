import { act, renderHook, waitFor } from '@testing-library/react-native';

import { seedAuthenticatedSession } from '@/testing/mocks/authFixtures';
import { MOCK_PASSWORD, MOCK_USERNAME } from '@/testing/mocks/handlers';
import * as biometricMock from '@/testing/mocks/biometric';

import { AuthProvider, useAuth } from '../AuthContext';
import { setBiometricUnlockEnabled } from '../biometric';
import { saveTokens } from '../tokenStorage';

async function renderAuth() {
  return renderHook(() => useAuth(), { wrapper: AuthProvider });
}

describe('AuthContext', () => {
  it('bootstraps to unauthenticated when no session is stored', async () => {
    const { result } = await renderAuth();

    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    expect(result.current.claims).toBeNull();
  });

  it('bootstraps straight to authenticated when a valid session exists and biometric unlock is off', async () => {
    await seedAuthenticatedSession();

    const { result } = await renderAuth();

    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    expect(result.current.claims?.tenant_id).toBeTruthy();
  });

  it('bootstraps to locked when a valid session exists and biometric unlock is on', async () => {
    await seedAuthenticatedSession();
    await setBiometricUnlockEnabled(true);

    const { result } = await renderAuth();

    await waitFor(() => expect(result.current.status).toBe('locked'));
  });

  it('signIn() succeeds with correct credentials and moves to authenticated', async () => {
    const { result } = await renderAuth();
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));

    await act(async () => {
      await result.current.signIn(MOCK_USERNAME, MOCK_PASSWORD);
    });

    await waitFor(() => expect(result.current.status).toBe('authenticated'));
  });

  it('signIn() with bad credentials rejects with a generic invalid_grant and stays unauthenticated', async () => {
    const { result } = await renderAuth();
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));

    await act(async () => {
      await expect(result.current.signIn(MOCK_USERNAME, 'wrong-password')).rejects.toMatchObject({
        error: 'invalid_grant',
      });
    });
    expect(result.current.status).toBe('unauthenticated');
  });

  it('unlockWithBiometric() success moves locked -> authenticated', async () => {
    await seedAuthenticatedSession();
    await setBiometricUnlockEnabled(true);
    const { result } = await renderAuth();
    await waitFor(() => expect(result.current.status).toBe('locked'));

    biometricMock.__setNextAuthResult({ success: true });
    let unlocked = false;
    await act(async () => {
      unlocked = await result.current.unlockWithBiometric();
    });

    expect(unlocked).toBe(true);
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
  });

  it('unlockWithBiometric() failure stays locked and reports failure rather than throwing', async () => {
    await seedAuthenticatedSession();
    await setBiometricUnlockEnabled(true);
    const { result } = await renderAuth();
    await waitFor(() => expect(result.current.status).toBe('locked'));

    biometricMock.__setNextAuthResult({ success: false });
    let unlocked = true;
    await act(async () => {
      unlocked = await result.current.unlockWithBiometric();
    });

    expect(unlocked).toBe(false);
    expect(result.current.status).toBe('locked');
  });

  it('a rejected refresh on bootstrap (invalid_grant) forces a clean logout, not a retry loop', async () => {
    // An already-expired access token paired with a refresh token the mock
    // server won't recognize — simulates both "just expired" and "reused
    // after rotation," which the server deliberately makes indistinguishable
    // (docs/adr/0150). Either way the only correct outcome is: log out.
    await saveTokens({
      accessToken: 'irrelevant.expired.token',
      refreshToken: 'stale-refresh-token',
      accessTokenExpiresAt: Date.now() - 1000,
    });

    const { result } = await renderAuth();

    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));
    expect(result.current.claims).toBeNull();
  });
});
