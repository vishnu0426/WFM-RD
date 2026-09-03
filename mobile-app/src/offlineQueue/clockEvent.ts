import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

import { enqueueAction, QueuedAction } from './storage';

type ClockEventType = 'clock_in' | 'clock_out';

/**
 * Pure client-side UX state, NOT a correctness guarantee — Module 06's own
 * `attendance-ingestion.service.ts` has no double-clock-in check at all
 * (confirmed by reading it: only clock-out checks for an open record), so
 * a double clock-in produces no server-side conflict signal whatsoever.
 * This marker exists only to warn the employee before they queue a
 * same-type-twice action locally; it is not, and cannot be, a substitute
 * for a real server-side guard (docs/module-11-phase-3-design-doc.md).
 */
const LAST_QUEUED_EVENT_TYPE_KEY = 'agno_wfm_last_queued_clock_event_type';

export async function getLastQueuedEventType(): Promise<ClockEventType | null> {
  const value = await AsyncStorage.getItem(LAST_QUEUED_EVENT_TYPE_KEY);
  return value === 'clock_in' || value === 'clock_out' ? value : null;
}

/**
 * `createdAtDevice` is captured synchronously, before any `await`, at the
 * moment this function is called — the sacred, immutable-once-queued
 * instant the whole module is built around.
 *
 * `location` (docs/adr/0155) is omitted from `payload` entirely when not
 * supplied — not set to `undefined` — so a geofencing-disabled tenant's
 * queued actions look identical to Phase 3-5's, and mobile-ess-service's
 * own strip-before-persist logic has a consistent "key present or not"
 * to key off.
 */
export async function queueClockEvent(
  eventType: ClockEventType,
  location?: { latitude: number; longitude: number; accuracy: number | null },
): Promise<void> {
  const createdAtDevice = new Date().toISOString();
  const id = Crypto.randomUUID();

  const action: QueuedAction = {
    id,
    actionType: 'clock_event',
    payload: location ? { eventType, location } : { eventType },
    createdAtDevice,
  };

  await enqueueAction(action);
  await AsyncStorage.setItem(LAST_QUEUED_EVENT_TYPE_KEY, eventType);
}
