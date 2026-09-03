import { ChunkedSecureStore } from './chunkedSecureStore';

export type OfflineActionType = 'clock_event' | 'leave_request' | 'marketplace_claim';

interface QueuedActionBase {
  id: string;
  /** Captured synchronously at the moment of queuing — sacred, immutable
   * once set (source spec's non-negotiable). */
  createdAtDevice: string;
}

export interface QueuedClockEventAction extends QueuedActionBase {
  actionType: 'clock_event';
  payload: {
    eventType: 'clock_in' | 'clock_out';
    /** Phase 6 (docs/adr/0155) — only present when geofencing is active
     * for the employee's org unit and location capture succeeded. Never
     * persisted server-side beyond the sync call that consumes it
     * (mobile-ess-service strips this key before writing its own queue
     * row). */
    location?: { latitude: number; longitude: number; accuracy: number | null };
  };
}

export interface QueuedLeaveRequestAction extends QueuedActionBase {
  actionType: 'leave_request';
  /** `YYYY-MM-DD` — matches attendance-leave-service's
   * `@IsDateString({strict:true})` exactly (docs/adr/0153). */
  payload: { leaveTypeId: string; dateRangeStart: string; dateRangeEnd: string };
}

export interface QueuedMarketplaceClaimAction extends QueuedActionBase {
  actionType: 'marketplace_claim';
  payload: { marketplacePostId: string };
}

/** Phase 4: all three source-spec action types (docs/module-11-phase-4-design-doc.md). */
export type QueuedAction = QueuedClockEventAction | QueuedLeaveRequestAction | QueuedMarketplaceClaimAction;

const queueStore = new ChunkedSecureStore<QueuedAction>('offline_queue');

export async function enqueueAction(action: QueuedAction): Promise<void> {
  await queueStore.add(action);
}

export async function listPendingActions(): Promise<QueuedAction[]> {
  return queueStore.list();
}

export async function removeAction(id: string): Promise<void> {
  await queueStore.remove(id);
}
