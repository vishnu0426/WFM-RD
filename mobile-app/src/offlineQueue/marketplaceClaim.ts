import * as Crypto from 'expo-crypto';

import { enqueueAction, QueuedAction } from './storage';

/**
 * `createdAtDevice` is captured synchronously, before any `await`, at the
 * moment this function is called — sacred, immutable once queued
 * (source spec's non-negotiable).
 */
export async function queueMarketplaceClaim(params: { marketplacePostId: string }): Promise<void> {
  const createdAtDevice = new Date().toISOString();
  const id = Crypto.randomUUID();

  const action: QueuedAction = {
    id,
    actionType: 'marketplace_claim',
    payload: params,
    createdAtDevice,
  };

  await enqueueAction(action);
}
