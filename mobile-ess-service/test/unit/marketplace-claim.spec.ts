import { OfflineActionType } from '../../src/mobile-sync/entities/offline-action-queue.entity';
import { MarketplaceClaimConflictError } from '../../src/mobile-sync/errors/marketplace-claim-conflict.error';
import { MarketplaceClaimForwardFailedError } from '../../src/mobile-sync/errors/marketplace-claim-forward-failed.error';
import {
  ACTION_ID,
  buildAction,
  createMobileSyncTestContext,
  EMPLOYEE_ID,
  TENANT_ID,
} from './support/mobile-sync-test-helpers';

const MARKETPLACE_PAYLOAD = { marketplacePostId: '55555555-5555-4555-8555-555555555555' };

function buildMarketplaceAction(overrides: Partial<Parameters<typeof buildAction>[0]> = {}) {
  return buildAction({ actionType: OfflineActionType.MARKETPLACE_CLAIM, payload: MARKETPLACE_PAYLOAD, ...overrides });
}

describe('MobileSyncService - marketplace_claim (service-level dispatch)', () => {
  it('processes a new marketplace_claim and forwards tenantId/employeeId/postId', async () => {
    const { repo, marketplaceClaimClient, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(null);
    marketplaceClaimClient.claim.mockResolvedValue(undefined);

    const results = await service.syncBatch(TENANT_ID, [buildMarketplaceAction()]);

    expect(results).toEqual([{ actionId: ACTION_ID, actionType: 'marketplace_claim', status: 'synced' }]);
    expect(marketplaceClaimClient.claim).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      employeeId: EMPLOYEE_ID,
      marketplacePostId: MARKETPLACE_PAYLOAD.marketplacePostId,
    });
  });

  it.each([
    ['POST_ALREADY_BEING_CLAIMED', 'Marketplace post was just claimed by someone else.'],
    ['POST_NOT_OPEN', 'This post is no longer open.'],
    ['MARKETPLACE_POST_NOT_FOUND', 'Post not found.'],
    ['CLAIM_REJECTED', 'The shift is no longer available to claim.'],
  ])('maps %s to status: conflict (this exact payload will never succeed unmodified)', async (code, message) => {
    const { repo, marketplaceClaimClient, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(null);
    marketplaceClaimClient.claim.mockRejectedValue(new MarketplaceClaimConflictError(code, message));

    const results = await service.syncBatch(TENANT_ID, [buildMarketplaceAction()]);

    expect(results).toEqual([
      { actionId: ACTION_ID, actionType: 'marketplace_claim', status: 'conflict', conflictDetails: { code, message } },
    ]);
  });

  it.each([
    ['CLAIM_ATTEMPT_RATE_LIMITED', 'Too many claim attempts.'],
    ['MARKETPLACE_UNAVAILABLE', 'Redis unreachable.'],
    ['GUARDRAIL_VALIDATION_UNAVAILABLE', 'scheduling-service gRPC unreachable.'],
  ])('maps %s to status: failed, retryable (safe to blind-retry)', async (_code, message) => {
    const { repo, marketplaceClaimClient, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(null);
    marketplaceClaimClient.claim.mockRejectedValue(new MarketplaceClaimForwardFailedError(200, message));

    const results = await service.syncBatch(TENANT_ID, [buildMarketplaceAction()]);

    expect(results).toEqual([
      { actionId: ACTION_ID, actionType: 'marketplace_claim', status: 'failed', detail: message },
    ]);
  });

  it('rejects a payload missing marketplacePostId as failed without calling the client', async () => {
    const { repo, marketplaceClaimClient, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(null);

    const results = await service.syncBatch(TENANT_ID, [buildMarketplaceAction({ payload: {} })]);

    expect(results[0].status).toBe('failed');
    expect(marketplaceClaimClient.claim).not.toHaveBeenCalled();
  });
});
