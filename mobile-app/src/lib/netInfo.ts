import { onlineManager } from '@tanstack/react-query';
import NetInfo from '@react-native-community/netinfo';

/**
 * React Native has no `navigator.onLine`, so TanStack Query's online-first
 * retry/refetch-on-reconnect behavior silently no-ops unless this is wired
 * explicitly (docs/module-11-phase-1-design-doc.md).
 */
export function setupOnlineManager(): void {
  onlineManager.setEventListener((setOnline) => {
    return NetInfo.addEventListener((state) => {
      setOnline(state.isConnected === true && state.isInternetReachable !== false);
    });
  });
}
