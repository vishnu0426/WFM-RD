import NetInfo from '@react-native-community/netinfo';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useCurrentIdentity } from '@/identity/useCurrentIdentity';

import { getMobileEssApiBaseUrl } from './mobileEssConfig';
import { syncPendingActions } from './syncEngine';

/**
 * Fires `syncPendingActions()` on the offline-to-online transition and on
 * app foreground while already online — the two moments a queued action
 * actually has a chance of leaving the device. Mount this once, inside the
 * authenticated (tabs) stack (`useCurrentIdentity()` requires it).
 */
export function useOfflineSyncTrigger(): void {
  const identity = useCurrentIdentity();

  useEffect(() => {
    const context = {
      tenantId: identity.tenantId,
      employeeId: identity.employeeId,
      mobileEssApiBaseUrl: getMobileEssApiBaseUrl(),
    };

    const trigger = () => {
      syncPendingActions(context).catch(() => {
        // syncPendingActions already swallows per-batch network errors;
        // this only guards against something unexpected (e.g. a storage
        // read failure) from becoming an unhandled rejection.
      });
    };

    trigger();

    const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) {
        trigger();
      }
    });

    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        trigger();
      }
    });

    return () => {
      unsubscribeNetInfo();
      appStateSubscription.remove();
    };
  }, [identity.tenantId, identity.employeeId]);
}
