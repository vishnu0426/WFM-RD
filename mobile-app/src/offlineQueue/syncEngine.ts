import { apiPost } from '@/api/client';
import { getOrCreateDeviceId } from '@/lib/deviceId';

import { addConflict } from './conflicts';
import { listPendingActions, OfflineActionType, removeAction } from './storage';

/** The module's own stated batch SLO bound — a queue that's grown larger
 * than this from an extended offline period chunks across multiple sync
 * calls, never one unbounded request. */
const MAX_BATCH_SIZE = 50;

interface SyncActionResult {
  actionId: string;
  actionType: OfflineActionType;
  status: 'synced' | 'failed' | 'conflict';
  conflictDetails?: { code?: string; message?: string };
  detail?: string;
}

interface SyncBatchResponse {
  results: SyncActionResult[];
}

export interface SyncContext {
  tenantId: string;
  employeeId: string;
  mobileEssApiBaseUrl: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Reads every pending queued action, chunks into <=50-action batches, and
 * POSTs each to `mobile-ess-service`. `synced` results are removed from
 * the local queue; `conflict` results move to the unresolved-conflicts
 * store (source spec's non-negotiable: never silently dropped or
 * auto-resolved); `failed` results are left queued for the next attempt.
 * A whole-batch network failure (mobile-ess-service unreachable) leaves
 * every action in that batch queued too - this function never throws, it
 * is meant to be called from a background reconnect/foreground trigger,
 * not awaited by user-facing UI that would need to surface the error.
 */
export async function syncPendingActions(context: SyncContext): Promise<void> {
  const pending = await listPendingActions();
  if (pending.length === 0) {
    return;
  }

  // Defensive - FIFO storage order already matches createdAtDevice order
  // in normal use, but mobile-sync.service.ts's own sequential-processing
  // guarantee depends on the batch actually being in that order.
  const ordered = [...pending].sort((a, b) => a.createdAtDevice.localeCompare(b.createdAtDevice));
  const deviceId = await getOrCreateDeviceId();

  for (const batch of chunk(ordered, MAX_BATCH_SIZE)) {
    let response: SyncBatchResponse;
    try {
      response = await apiPost<SyncBatchResponse>(
        '/v1/mobile/sync',
        {
          deviceId,
          actions: batch.map((action) => ({
            id: action.id,
            employeeId: context.employeeId,
            actionType: action.actionType,
            payload: action.payload,
            createdAtDevice: action.createdAtDevice,
          })),
        },
        { apiBaseUrl: context.mobileEssApiBaseUrl, tenantId: context.tenantId },
      );
    } catch {
      // Whole batch unreachable - leave every action in it queued for the
      // next sync attempt, don't let one offline stretch crash the caller.
      continue;
    }

    for (const result of response.results) {
      if (result.status === 'synced') {
        await removeAction(result.actionId);
      } else if (result.status === 'conflict') {
        await addConflict({
          id: result.actionId,
          actionType: result.actionType,
          code: result.conflictDetails?.code ?? 'CONFLICT',
          message: result.conflictDetails?.message ?? 'A conflict occurred.',
          detectedAt: new Date().toISOString(),
        });
        await removeAction(result.actionId);
      }
      // 'failed': leave queued, retried on the next sync pass.
    }
  }
}
