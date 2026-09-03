import { ChunkedSecureStore } from './chunkedSecureStore';
import { OfflineActionType } from './storage';

/**
 * A conflict is never auto-resolved (source spec's non-negotiable) — kept
 * here until the employee explicitly dismisses it. Dismiss is the only
 * action this phase supports; a richer resolution flow (e.g. retry with a
 * new action id) isn't needed for any of the three action types' real
 * conflict cases and is left as an open question for whichever later
 * phase needs one (docs/module-11-phase-3-design-doc.md).
 */
export interface QueuedConflict {
  id: string;
  actionType: OfflineActionType;
  code: string;
  message: string;
  /** When this conflict was surfaced, for display ordering. */
  detectedAt: string;
}

const conflictsStore = new ChunkedSecureStore<QueuedConflict>('offline_queue_conflicts');

export async function addConflict(conflict: QueuedConflict): Promise<void> {
  await conflictsStore.add(conflict);
}

export async function listConflicts(): Promise<QueuedConflict[]> {
  return conflictsStore.list();
}

export async function dismissConflict(id: string): Promise<void> {
  await conflictsStore.remove(id);
}
