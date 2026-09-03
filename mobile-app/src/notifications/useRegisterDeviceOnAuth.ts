import { useEffect } from 'react';
import { Platform } from 'react-native';

import { useCurrentIdentity } from '@/identity/useCurrentIdentity';
import { getOrCreateDeviceId } from '@/lib/deviceId';

import { getOrRequestPushToken } from './pushToken';
import { registerDevice } from './registerDevice';

/**
 * ADR-0154. Mounted once in `(tabs)/_layout.tsx`, not mirroring
 * `useOfflineSyncTrigger`'s screen-level placement (Schedule-specific,
 * itself a minor rough edge) - this hook is genuinely tab-agnostic.
 * `Stack.Protected guard={status === 'authenticated'}` (`app/_layout.tsx`)
 * mounts `(tabs)` fresh exactly once per authenticated-session-start (cold
 * boot already-signed-in, fresh sign-in, or biometric unlock all funnel
 * through that one guard transition), which is what makes a plain
 * `useEffect` here sufficient - no separate "on every app foreground"
 * logic needed, unlike `useOfflineSyncTrigger`.
 *
 * `registerDevice` is upsert-based server-side, so calling this on every
 * authenticated-session-start is intentional, not wasteful - it's what
 * keeps `push_token`/`app_version`/`last_active_at` fresh without a
 * separate heartbeat endpoint.
 *
 * Errors are swallowed (logged only) - a push-registration failure must
 * never block using the app, same posture `useOfflineSyncTrigger` already
 * takes toward its own background sync failures.
 */
export function useRegisterDeviceOnAuth(): void {
  const identity = useCurrentIdentity();

  useEffect(() => {
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
      // No real push token to register on web - `expo-notifications`'
      // web behavior is a different mechanism entirely, out of scope.
      return;
    }

    (async () => {
      const pushToken = await getOrRequestPushToken();
      if (!pushToken) {
        return;
      }
      const deviceId = await getOrCreateDeviceId();
      await registerDevice({
        tenantId: identity.tenantId,
        employeeId: identity.employeeId,
        deviceType: Platform.OS as 'ios' | 'android',
        deviceId,
        pushToken,
      });
    })().catch(() => {
      // A push-registration failure (no permission, no EAS project id,
      // mobile-ess-service unreachable) must never block using the app -
      // same swallow-and-continue posture `useOfflineSyncTrigger` already
      // takes toward its own background failures.
    });
  }, [identity.tenantId, identity.employeeId]);
}
