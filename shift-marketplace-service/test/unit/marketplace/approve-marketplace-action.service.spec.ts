import { DataSource, EntityManager } from 'typeorm';
import { ApproveMarketplaceActionService } from '../../../src/marketplace/approve-marketplace-action.service';
import {
  MarketplaceClaim,
  MarketplaceClaimSource,
  MarketplaceClaimStatus,
} from '../../../src/marketplace/entities/marketplace-claim.entity';
import {
  MarketplacePost,
  MarketplacePostStatus,
  MarketplacePostType,
} from '../../../src/marketplace/entities/marketplace-post.entity';
import { SwapRequest, SwapRequestStatus } from '../../../src/marketplace/entities/swap-request.entity';
import { MarketplaceEventPublisherService } from '../../../src/marketplace/marketplace-event-publisher.service';
import { MarketplaceEngagementService } from '../../../src/marketplace/marketplace-engagement.service';
import { MarketplaceClaimNotFoundError } from '../../../src/marketplace/errors/marketplace-claim-not-found.error';
import { ActionNotPendingApprovalError } from '../../../src/marketplace/errors/action-not-pending-approval.error';
import { SwapRequestNotFoundError } from '../../../src/marketplace/errors/swap-request-not-found.error';

const TENANT_ID = 'tenant-1';
const APPROVER_ID = 'supervisor-1';

describe('ApproveMarketplaceActionService (§3.1, ADR-0089/ADR-0091)', () => {
  let manager: { findOne: jest.Mock; findOneOrFail: jest.Mock; save: jest.Mock; query: jest.Mock };
  let dataSource: Partial<DataSource>;
  let eventPublisher: { recordClaimApproved: jest.Mock; recordSwapExecuted: jest.Mock };
  let engagement: { recordEvent: jest.Mock };
  let service: ApproveMarketplaceActionService;

  beforeEach(() => {
    manager = {
      findOne: jest.fn(),
      findOneOrFail: jest.fn(),
      save: jest.fn(async (v: unknown) => v),
      query: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
      ) as unknown as DataSource['transaction'],
    };
    eventPublisher = {
      recordClaimApproved: jest.fn().mockResolvedValue(undefined),
      recordSwapExecuted: jest.fn().mockResolvedValue(undefined),
    };
    engagement = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    service = new ApproveMarketplaceActionService(
      dataSource as DataSource,
      eventPublisher as unknown as MarketplaceEventPublisherService,
      engagement as unknown as MarketplaceEngagementService,
    );
  });

  it('approveClaim moves a pending_approval claim to approved, notifies Module 04, and records an engagement event', async () => {
    const claim: MarketplaceClaim = {
      id: 'claim-1',
      tenantId: TENANT_ID,
      marketplacePostId: 'post-1',
      claimantEmployeeId: 'employee-1',
      status: MarketplaceClaimStatus.PENDING_APPROVAL,
      source: MarketplaceClaimSource.OPEN_SHIFT_CLAIM,
      validationResult: null,
      claimedAt: new Date(),
      decisionReason: null,
    };
    const post: MarketplacePost = {
      id: 'post-1',
      tenantId: TENANT_ID,
      postType: MarketplacePostType.OPEN_SHIFT,
      shiftAssignmentId: 'shift-1',
      orgUnitId: 'org-1',
      postedBy: null,
      status: MarketplacePostStatus.CLAIMED,
      eligibilityRules: {},
      expiresAt: new Date(),
      createdAt: new Date(),
    };
    manager.findOne.mockResolvedValueOnce(claim);
    manager.findOneOrFail.mockResolvedValueOnce(post);

    const result = await service.approveClaim(TENANT_ID, 'claim-1', APPROVER_ID);

    expect(result.status).toBe(MarketplaceClaimStatus.APPROVED);
    expect(eventPublisher.recordClaimApproved).toHaveBeenCalledWith(manager, {
      tenantId: TENANT_ID,
      marketplaceClaimId: 'claim-1',
      marketplacePostId: 'post-1',
      shiftAssignmentId: 'shift-1',
      claimantEmployeeId: 'employee-1',
      approvedBy: APPROVER_ID,
      source: MarketplaceClaimSource.OPEN_SHIFT_CLAIM,
    });
    expect(engagement.recordEvent).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      employeeId: 'employee-1',
      eventType: 'claim_approved',
      referenceId: 'claim-1',
    });
  });

  it('approveClaim: a claim sourced from a closed BidOpportunity notifies Module 04 with source: bid', async () => {
    const claim: MarketplaceClaim = {
      id: 'claim-2',
      tenantId: TENANT_ID,
      marketplacePostId: 'post-1',
      claimantEmployeeId: 'employee-1',
      status: MarketplaceClaimStatus.PENDING_APPROVAL,
      source: MarketplaceClaimSource.BID,
      validationResult: { eligible: true, violations: [] },
      claimedAt: new Date(),
      decisionReason: null,
    };
    const post: MarketplacePost = {
      id: 'post-1',
      tenantId: TENANT_ID,
      postType: MarketplacePostType.BID,
      shiftAssignmentId: 'shift-1',
      orgUnitId: 'org-1',
      postedBy: null,
      status: MarketplacePostStatus.CLAIMED,
      eligibilityRules: {},
      expiresAt: new Date(),
      createdAt: new Date(),
    };
    manager.findOne.mockResolvedValueOnce(claim);
    manager.findOneOrFail.mockResolvedValueOnce(post);

    await service.approveClaim(TENANT_ID, 'claim-2', APPROVER_ID);

    expect(eventPublisher.recordClaimApproved).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ source: MarketplaceClaimSource.BID }),
    );
  });

  it('approveClaim throws MarketplaceClaimNotFoundError and never touches engagement/events when the claim does not exist', async () => {
    manager.findOne.mockResolvedValueOnce(null);

    await expect(service.approveClaim(TENANT_ID, 'missing', APPROVER_ID)).rejects.toBeInstanceOf(
      MarketplaceClaimNotFoundError,
    );
    expect(eventPublisher.recordClaimApproved).not.toHaveBeenCalled();
    expect(engagement.recordEvent).not.toHaveBeenCalled();
  });

  it('approveClaim throws ActionNotPendingApprovalError for a claim not in pending_approval', async () => {
    manager.findOne.mockResolvedValueOnce({
      id: 'claim-1',
      tenantId: TENANT_ID,
      status: MarketplaceClaimStatus.APPROVED,
    });

    await expect(service.approveClaim(TENANT_ID, 'claim-1', APPROVER_ID)).rejects.toBeInstanceOf(
      ActionNotPendingApprovalError,
    );
    expect(engagement.recordEvent).not.toHaveBeenCalled();
  });

  it('approveSwap moves a pending_approval swap to accepted and records an engagement event for both participants', async () => {
    const swap: SwapRequest = {
      id: 'swap-1',
      tenantId: TENANT_ID,
      initiatorEmployeeId: 'initiator-1',
      initiatorShiftId: 'shift-a',
      initiatorOrgUnitId: 'org-1',
      targetEmployeeId: 'target-1',
      targetShiftId: 'shift-b',
      targetOrgUnitId: 'org-2',
      status: SwapRequestStatus.PENDING_APPROVAL,
      requiresSupervisorApproval: true,
      validationResult: null,
      createdAt: new Date(),
      decisionReason: null,
    };
    manager.findOne.mockResolvedValueOnce(swap);

    const result = await service.approveSwap(TENANT_ID, 'swap-1', APPROVER_ID);

    expect(result.status).toBe(SwapRequestStatus.ACCEPTED);
    expect(eventPublisher.recordSwapExecuted).toHaveBeenCalledWith(manager, {
      tenantId: TENANT_ID,
      swapRequestId: 'swap-1',
      initiatorEmployeeId: 'initiator-1',
      initiatorShiftId: 'shift-a',
      targetEmployeeId: 'target-1',
      targetShiftId: 'shift-b',
      approvedBy: APPROVER_ID,
    });
    expect(engagement.recordEvent).toHaveBeenCalledTimes(2);
    expect(engagement.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, employeeId: 'initiator-1', referenceId: 'swap-1' }),
    );
    expect(engagement.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, employeeId: 'target-1', referenceId: 'swap-1' }),
    );
  });

  describe('rejectClaim/rejectSwap (Shift Marketplace Manager View phase, §2)', () => {
    it('rejectClaim moves a pending_approval claim to rejected, persists the reason, and fires no downstream events', async () => {
      const claim: MarketplaceClaim = {
        id: 'claim-1',
        tenantId: TENANT_ID,
        marketplacePostId: 'post-1',
        claimantEmployeeId: 'employee-1',
        status: MarketplaceClaimStatus.PENDING_APPROVAL,
        source: MarketplaceClaimSource.OPEN_SHIFT_CLAIM,
        validationResult: null,
        claimedAt: new Date(),
        decisionReason: null,
      };
      manager.findOne.mockResolvedValueOnce(claim);

      const result = await service.rejectClaim(TENANT_ID, 'claim-1', 'Coverage gap on the requested dates.');

      expect(result.status).toBe(MarketplaceClaimStatus.REJECTED);
      expect(result.decisionReason).toBe('Coverage gap on the requested dates.');
      expect(eventPublisher.recordClaimApproved).not.toHaveBeenCalled();
      expect(engagement.recordEvent).not.toHaveBeenCalled();
    });

    it('rejectClaim throws MarketplaceClaimNotFoundError when the claim does not exist', async () => {
      manager.findOne.mockResolvedValueOnce(null);

      await expect(service.rejectClaim(TENANT_ID, 'missing', 'reason')).rejects.toBeInstanceOf(
        MarketplaceClaimNotFoundError,
      );
    });

    it('rejectClaim throws ActionNotPendingApprovalError for a claim not in pending_approval', async () => {
      manager.findOne.mockResolvedValueOnce({
        id: 'claim-1',
        tenantId: TENANT_ID,
        status: MarketplaceClaimStatus.APPROVED,
      });

      await expect(service.rejectClaim(TENANT_ID, 'claim-1', 'reason')).rejects.toBeInstanceOf(
        ActionNotPendingApprovalError,
      );
    });

    it('rejectSwap moves a pending_approval swap to rejected, persists the reason, and fires no downstream events', async () => {
      const swap: SwapRequest = {
        id: 'swap-1',
        tenantId: TENANT_ID,
        initiatorEmployeeId: 'initiator-1',
        initiatorShiftId: 'shift-a',
        initiatorOrgUnitId: 'org-1',
        targetEmployeeId: 'target-1',
        targetShiftId: 'shift-b',
        targetOrgUnitId: 'org-2',
        status: SwapRequestStatus.PENDING_APPROVAL,
        requiresSupervisorApproval: true,
        validationResult: null,
        createdAt: new Date(),
        decisionReason: null,
      };
      manager.findOne.mockResolvedValueOnce(swap);

      const result = await service.rejectSwap(TENANT_ID, 'swap-1', 'Target employee no longer eligible.');

      expect(result.status).toBe(SwapRequestStatus.REJECTED);
      expect(result.decisionReason).toBe('Target employee no longer eligible.');
      expect(eventPublisher.recordSwapExecuted).not.toHaveBeenCalled();
      expect(engagement.recordEvent).not.toHaveBeenCalled();
    });

    it('rejectSwap throws SwapRequestNotFoundError when the swap does not exist', async () => {
      manager.findOne.mockResolvedValueOnce(null);

      await expect(service.rejectSwap(TENANT_ID, 'missing', 'reason')).rejects.toBeInstanceOf(SwapRequestNotFoundError);
    });
  });
});
