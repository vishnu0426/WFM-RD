import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useCurrentIdentity } from '@/identity/useCurrentIdentity';
import { colors } from '@/lib/a11y/tokens';

import { Button } from '@/components/ui/Button';
import { captureClockEventLocation } from '@/geofence/captureLocation';
import { GeofenceDisclosureCard } from '@/geofence/GeofenceDisclosureCard';
import { useGeofenceGate } from '@/geofence/useGeofenceGate';
import { getLastQueuedEventType, queueClockEvent } from '@/offlineQueue/clockEvent';
import { getMobileEssApiBaseUrl } from '@/offlineQueue/mobileEssConfig';
import { syncPendingActions } from '@/offlineQueue/syncEngine';

type ClockEventType = 'clock_in' | 'clock_out';

/**
 * No "currently clocked in" status is shown — there is no read endpoint
 * for it anywhere in the platform (building one would be new business
 * logic, against this module's explicit non-goals). The same-type-twice
 * warning below is a client-side UX guard only, not a correctness
 * guarantee: Module 06's own clock-in path has no double-clock-in check at
 * all (confirmed by reading `attendance-ingestion.service.ts`), so this
 * warning can be wrong if attendance was also recorded another way
 * (docs/module-11-phase-3-design-doc.md).
 */
export function ClockInOutControls() {
  const identity = useCurrentIdentity();
  const geofenceGate = useGeofenceGate({ tenantId: identity.tenantId, employeeId: identity.employeeId });
  const [lastEventType, setLastEventType] = useState<ClockEventType | null>(null);
  const [isQueuing, setIsQueuing] = useState<ClockEventType | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    getLastQueuedEventType().then(setLastEventType);
  }, []);

  const handlePress = async (eventType: ClockEventType) => {
    setMessage(null);
    setIsQueuing(eventType);
    try {
      const location = geofenceGate.active ? await captureClockEventLocation() : undefined;
      await queueClockEvent(eventType, location ?? undefined);
      setLastEventType(eventType);
      setMessage(eventType === 'clock_in' ? 'Clock-in queued.' : 'Clock-out queued.');
      // Best-effort immediate sync attempt - harmless if offline (leaves
      // the action queued) or if this races the reconnect/foreground
      // trigger (storage.ts's mutex serializes them).
      void syncPendingActions({
        tenantId: identity.tenantId,
        employeeId: identity.employeeId,
        mobileEssApiBaseUrl: getMobileEssApiBaseUrl(),
      });
    } finally {
      setIsQueuing(null);
    }
  };

  return (
    <View style={styles.container}>
      {geofenceGate.needsDisclosure ? (
        <GeofenceDisclosureCard onAcknowledge={geofenceGate.acknowledge} />
      ) : null}
      <View style={styles.row}>
        <View style={styles.buttonWrapper}>
          <Button
            label="Clock In"
            onPress={() => handlePress('clock_in')}
            loading={isQueuing === 'clock_in'}
            disabled={isQueuing !== null}
            accessibilityHint={
              lastEventType === 'clock_in' ? 'You already queued a clock-in without a clock-out after it.' : undefined
            }
          />
        </View>
        <View style={styles.buttonWrapper}>
          <Button
            label="Clock Out"
            onPress={() => handlePress('clock_out')}
            loading={isQueuing === 'clock_out'}
            disabled={isQueuing !== null}
            accessibilityHint={
              lastEventType === 'clock_out'
                ? 'You already queued a clock-out without a clock-in after it.'
                : undefined
            }
          />
        </View>
      </View>
      {lastEventType ? (
        <Text style={styles.hint} accessibilityRole="text">
          Last queued: {lastEventType === 'clock_in' ? 'Clock In' : 'Clock Out'}
        </Text>
      ) : null}
      {message ? (
        <Text style={styles.message} accessibilityRole="alert">
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  buttonWrapper: {
    flex: 1,
  },
  hint: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  message: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
});
