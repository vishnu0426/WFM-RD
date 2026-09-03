import * as Crypto from 'expo-crypto';

import { enqueueAction, QueuedAction } from './storage';

/**
 * `createdAtDevice` is captured synchronously, before any `await`, at the
 * moment this function is called — sacred, immutable once queued
 * (source spec's non-negotiable). `dateRangeEnd >= dateRangeStart` is
 * validated by the caller (`app/(tabs)/leave.tsx`) before this is ever
 * invoked — not a forms nicety, a sync-queue-hygiene guardrail: without
 * it, attendance-leave-service's `InvalidLeaveRequestError` becomes a
 * reachable, deterministic conflict from this form's own input
 * (docs/adr/0153).
 */
export async function queueLeaveRequest(params: {
  leaveTypeId: string;
  dateRangeStart: string;
  dateRangeEnd: string;
}): Promise<void> {
  const createdAtDevice = new Date().toISOString();
  const id = Crypto.randomUUID();

  const action: QueuedAction = {
    id,
    actionType: 'leave_request',
    payload: params,
    createdAtDevice,
  };

  await enqueueAction(action);
}
