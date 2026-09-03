import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';

/**
 * ADR-0154. Mounted at `RootLayout` (not gated on auth - receiving/tapping
 * a notification isn't conditioned on being currently signed in). Per
 * ADR-0154's scope cut: tapping a notification shows the OS system UI
 * only, no in-app deep-link navigation this phase - the response listener
 * is a deliberate no-op, not a missing feature.
 */
export function useNotificationListeners(): void {
  useEffect(() => {
    const receivedSubscription = Notifications.addNotificationReceivedListener(() => {
      // Foreground receipt - no custom in-app banner this phase, the OS
      // notification UI is sufficient (ADR-0154's scope cut).
    });
    const responseSubscription = Notifications.addNotificationResponseReceivedListener(() => {
      // Tap/response - deliberately a no-op, no deep-link routing this
      // phase (ADR-0154's scope cut).
    });

    return () => {
      receivedSubscription.remove();
      responseSubscription.remove();
    };
  }, []);
}
