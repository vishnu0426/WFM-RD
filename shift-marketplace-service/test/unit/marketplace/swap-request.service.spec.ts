import { DataSource, EntityManager } from 'typeorm';
import { SwapRequestService } from '../../../src/marketplace/swap-request.service';
import { GuardrailValidationService } from '../../../src/marketplace/guardrail-validation.service';
import { MarketplaceRedisService, MarketplaceRedisUnavailableError } from '../../../src/redis/redis.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { SwapRequest, SwapRequestStatus } from '../../../src/marketplace/entities/swap-request.entity';
import { SwapRequestNotFoundError } from '../../../src/marketplace/errors/swap-request-not-found.error';
import { SwapRequestNotPendingError } from '../../../src/marketplace/errors/swap-request-not-pending.error';
import { NotYourSwapToRespondToError } from '../../../src/marketplace/errors/not-your-swap-to-respond-to.error';
import { SwapOfferedShiftRequiredError } from '../../../src/marketplace/errors/swap-offered-shift-required.error';
import { SwapAlreadyBeingRespondedToError } from '../../../src/marketplace/errors/swap-already-being-responded-to.error';
import { MarketplaceUnavailableError } from '../../../src/marketplace/errors/marketplace-unavailable.error';
import { GuardrailValidationUnavailableError } from '../../../src/marketplace/errors/guardrail-validation-unavailable.error';
import { TenantMarketplacePolicyService } from '../../../src/marketplace/tenant-marketplace-policy.service';
import { MarketplaceEventPublisherService } from '../../../src/marketplace/marketplace-event-publisher.service';
import { MarketplaceEngagementService } from '../../../src/marketplace/marketplace-engagement.service';

const TENANT_ID = 'tenant-1';
const SWAP_ID = 'swap-1';
const INITIATOR_ID = 'initiator-1';
const RESPONDER_ID = 'responder-1';

function swap(overrides: Partial<SwapRequest> = {}): SwapRequest {
  return {
    id: SWAP_ID,
    tenantId: TENANT_ID,
    initiatorEmployeeId: INITIATOR_ID,
    initiatorShiftId: 'initiator-shift-1',
    initiatorOrgUnitId: 'org-1',
    targetEmployeeId: null,
    targetShiftId: null,
    targetOrgUnitId: null,
    status: SwapRequestStatus.PENDING,
    requiresSupervisorApproval: true,
    validationResult: null,
    createdAt: new Date(),
    decisionReason: null,
    ...overrides,
  };
}

describe('SwapRequestService (§8 Phase 3, ADR-0087)', () => {
  let dataSource: Partial<DataSource>;
  let manager: { findOne: jest.Mock; findOneOrFail: jest.Mock; create: jest.Mock; save: jest.Mock; query: jest.Mock };
  let redis: { acquireClaimLock: jest.Mock; releaseClaimLock: jest.Mock };
  let guardrailValidation: { checkEligibility: jest.Mock };
  let metrics: MetricsService;
  let tenantPolicy: { isAutoApprovalEnabled: jest.Mock };
  let eventPublisher: { recordSwapExecuted: jest.Mock };
  let engagement: { recordEvent: jest.Mock };
  let currentSwap: SwapRequest;
  let service: SwapRequestService;

  beforeEach(() => {
    currentSwap = swap();

    manager = {
      // GAP-01: `respondToSwap`'s target-resolution and final-decision
      // writes now run raw conditional UPDATE ... RETURNING statements
      // through `manager.query` - default to "the conditional UPDATE
      // matched" so every pre-existing happy-path test keeps its original
      // behavior unchanged. TypeORM's `EntityManager.query()` returns
      // `[rows, rowCount]` for an UPDATE (even with RETURNING), not the
      // rows array directly - see claim-open-shift.service.spec.ts's
      // identical mock for the full explanation of why this shape matters.
      query: jest.fn().mockResolvedValue([[{ id: 'swap-1' }], 1]),
      findOne: jest.fn(async () => currentSwap),
      findOneOrFail: jest.fn(async () => currentSwap),
      create: jest.fn((_entity: unknown, values: SwapRequest) => {
        currentSwap = values;
        return values;
      }),
      save: jest.fn(async (value: SwapRequest) => {
        currentSwap = value;
        return value;
      }),
    };
    dataSource = {
      transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
      ) as unknown as DataSource['transaction'],
    };
    redis = {
      acquireClaimLock: jest.fn().mockResolvedValue('token-1'),
      releaseClaimLock: jest.fn().mockResolvedValue(undefined),
    };
    guardrailValidation = {
      checkEligibility: jest.fn().mockResolvedValue({ shiftAssignmentFound: true, eligible: true, violations: [] }),
    };
    metrics = new MetricsService();
    tenantPolicy = { isAutoApprovalEnabled: jest.fn().mockReturnValue(false) };
    eventPublisher = { recordSwapExecuted: jest.fn().mockResolvedValue(undefined) };
    engagement = { recordEvent: jest.fn().mockResolvedValue(undefined) };

    service = new SwapRequestService(
      dataSource as DataSource,
      redis as unknown as MarketplaceRedisService,
      guardrailValidation as unknown as GuardrailValidationService,
      metrics,
      tenantPolicy as unknown as TenantMarketplacePolicyService,
      eventPublisher as unknown as MarketplaceEventPublisherService,
      engagement as unknown as MarketplaceEngagementService,
    );
  });

  it('proposeSwap creates a pending swap, closed (target named) or open (target null)', async () => {
    const result = await service.proposeSwap({
      tenantId: TENANT_ID,
      initiatorEmployeeId: INITIATOR_ID,
      initiatorShiftId: 'shift-a',
      initiatorOrgUnitId: 'org-1',
    });
    expect(result.status).toBe(SwapRequestStatus.PENDING);
    expect(result.targetEmployeeId).toBeNull();
  });

  it('§4 step 3 analogue: two concurrent accepts on an open swap - the loser gets the immediate fast-fail', async () => {
    redis.acquireClaimLock.mockResolvedValue(null);

    await expect(
      service.respondToSwap({
        tenantId: TENANT_ID,
        swapRequestId: SWAP_ID,
        respondingEmployeeId: RESPONDER_ID,
        accept: true,
        offeredShiftId: 's',
        offeredOrgUnitId: 'o',
      }),
    ).rejects.toBeInstanceOf(SwapAlreadyBeingRespondedToError);
  });

  it('§0.5 Redis chaos: fails closed when Redis is unreachable', async () => {
    redis.acquireClaimLock.mockRejectedValue(
      new MarketplaceRedisUnavailableError('acquireClaimLock', new Error('down')),
    );

    await expect(
      service.respondToSwap({
        tenantId: TENANT_ID,
        swapRequestId: SWAP_ID,
        respondingEmployeeId: RESPONDER_ID,
        accept: true,
      }),
    ).rejects.toBeInstanceOf(MarketplaceUnavailableError);
  });

  it('reject requires being the named target - an open swap cannot be rejected via this path', async () => {
    await expect(
      service.respondToSwap({
        tenantId: TENANT_ID,
        swapRequestId: SWAP_ID,
        respondingEmployeeId: RESPONDER_ID,
        accept: false,
      }),
    ).rejects.toBeInstanceOf(NotYourSwapToRespondToError);
  });

  it('reject by the correctly named target moves the swap to rejected', async () => {
    currentSwap = swap({ targetEmployeeId: RESPONDER_ID, targetShiftId: 'target-shift', targetOrgUnitId: 'org-2' });

    const result = await service.respondToSwap({
      tenantId: TENANT_ID,
      swapRequestId: SWAP_ID,
      respondingEmployeeId: RESPONDER_ID,
      accept: false,
    });

    expect(result.status).toBe(SwapRequestStatus.REJECTED);
  });

  it('rejects an accept from someone other than the named target on a closed swap', async () => {
    currentSwap = swap({ targetEmployeeId: 'someone-else', targetShiftId: 'target-shift', targetOrgUnitId: 'org-2' });

    await expect(
      service.respondToSwap({
        tenantId: TENANT_ID,
        swapRequestId: SWAP_ID,
        respondingEmployeeId: RESPONDER_ID,
        accept: true,
      }),
    ).rejects.toBeInstanceOf(NotYourSwapToRespondToError);
  });

  it('an open swap accept with no offered shift is rejected before any guardrail call', async () => {
    await expect(
      service.respondToSwap({
        tenantId: TENANT_ID,
        swapRequestId: SWAP_ID,
        respondingEmployeeId: RESPONDER_ID,
        accept: true,
      }),
    ).rejects.toBeInstanceOf(SwapOfferedShiftRequiredError);
    expect(guardrailValidation.checkEligibility).not.toHaveBeenCalled();
  });

  it('throws SwapRequestNotFoundError when the swap does not exist', async () => {
    manager.findOne.mockResolvedValue(null);

    await expect(
      service.respondToSwap({
        tenantId: TENANT_ID,
        swapRequestId: SWAP_ID,
        respondingEmployeeId: RESPONDER_ID,
        accept: true,
        offeredShiftId: 's',
        offeredOrgUnitId: 'o',
      }),
    ).rejects.toBeInstanceOf(SwapRequestNotFoundError);
  });

  it('throws SwapRequestNotPendingError when the swap is already accepted', async () => {
    currentSwap = swap({ status: SwapRequestStatus.ACCEPTED });
    manager.findOne.mockResolvedValue(currentSwap);

    await expect(
      service.respondToSwap({
        tenantId: TENANT_ID,
        swapRequestId: SWAP_ID,
        respondingEmployeeId: RESPONDER_ID,
        accept: true,
        offeredShiftId: 's',
        offeredOrgUnitId: 'o',
      }),
    ).rejects.toBeInstanceOf(SwapRequestNotPendingError);
  });

  it('§4 step 4 analogue: both sides eligible, no tenant auto-approval -> pending_approval, Module 04 not notified yet', async () => {
    const result = await service.respondToSwap({
      tenantId: TENANT_ID,
      swapRequestId: SWAP_ID,
      respondingEmployeeId: RESPONDER_ID,
      accept: true,
      offeredShiftId: 'target-shift',
      offeredOrgUnitId: 'org-2',
    });

    expect(result.status).toBe(SwapRequestStatus.PENDING_APPROVAL);
    expect(result.validationResult).toEqual({ eligible: true, initiatorViolations: [], responderViolations: [] });
    expect(eventPublisher.recordSwapExecuted).not.toHaveBeenCalled();
    expect(engagement.recordEvent).not.toHaveBeenCalled();
    expect(guardrailValidation.checkEligibility).toHaveBeenCalledTimes(2);
    expect(guardrailValidation.checkEligibility).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateEmployeeId: INITIATOR_ID,
        shiftAssignmentId: 'target-shift',
        orgUnitId: 'org-2',
        excludeShiftAssignmentId: 'initiator-shift-1',
      }),
    );
    expect(guardrailValidation.checkEligibility).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateEmployeeId: RESPONDER_ID,
        shiftAssignmentId: 'initiator-shift-1',
        orgUnitId: 'org-1',
        excludeShiftAssignmentId: 'target-shift',
      }),
    );
  });

  it('§4 step 5 analogue: only the responder side is ineligible -> rejected, with only that side carrying violations', async () => {
    guardrailValidation.checkEligibility.mockImplementation(async (req: { candidateEmployeeId: string }) => {
      if (req.candidateEmployeeId === RESPONDER_ID) {
        return { shiftAssignmentFound: true, eligible: false, violations: [{ category: 'min_rest', detail: 'x' }] };
      }
      return { shiftAssignmentFound: true, eligible: true, violations: [] };
    });

    const result = await service.respondToSwap({
      tenantId: TENANT_ID,
      swapRequestId: SWAP_ID,
      respondingEmployeeId: RESPONDER_ID,
      accept: true,
      offeredShiftId: 'target-shift',
      offeredOrgUnitId: 'org-2',
    });

    expect(result.status).toBe(SwapRequestStatus.REJECTED);
    expect(result.validationResult).toMatchObject({
      eligible: false,
      initiatorViolations: [],
      responderViolations: [{ category: 'min_rest', detail: 'x' }],
    });
  });

  it('§0.5 guardrail-gRPC chaos: fails closed, marks the swap rejected rather than stuck', async () => {
    guardrailValidation.checkEligibility.mockRejectedValue(new GuardrailValidationUnavailableError());

    await expect(
      service.respondToSwap({
        tenantId: TENANT_ID,
        swapRequestId: SWAP_ID,
        respondingEmployeeId: RESPONDER_ID,
        accept: true,
        offeredShiftId: 'target-shift',
        offeredOrgUnitId: 'org-2',
      }),
    ).rejects.toBeInstanceOf(GuardrailValidationUnavailableError);

    expect(currentSwap.status).toBe(SwapRequestStatus.REJECTED);
    expect(currentSwap.validationResult).toEqual({ eligible: false, reason: 'guardrail_validation_unavailable' });
    expect(redis.releaseClaimLock).toHaveBeenCalledWith(TENANT_ID, SWAP_ID, 'token-1');
  });

  it('a closed swap (target already named) uses its own pre-named target shift/org unit, ignoring any offered* args', async () => {
    currentSwap = swap({
      targetEmployeeId: RESPONDER_ID,
      targetShiftId: 'named-target-shift',
      targetOrgUnitId: 'named-org',
    });
    manager.findOne.mockImplementation(async () => currentSwap);

    await service.respondToSwap({
      tenantId: TENANT_ID,
      swapRequestId: SWAP_ID,
      respondingEmployeeId: RESPONDER_ID,
      accept: true,
    });

    expect(guardrailValidation.checkEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ shiftAssignmentId: 'named-target-shift', orgUnitId: 'named-org' }),
    );
  });

  it('§0.5/ADR-0089: with tenant auto-approval enabled, both sides eligible -> accepted immediately and Module 04 is notified via SwapExecuted', async () => {
    tenantPolicy.isAutoApprovalEnabled.mockReturnValue(true);

    const result = await service.respondToSwap({
      tenantId: TENANT_ID,
      swapRequestId: SWAP_ID,
      respondingEmployeeId: RESPONDER_ID,
      accept: true,
      offeredShiftId: 'target-shift',
      offeredOrgUnitId: 'org-2',
    });

    expect(result.status).toBe(SwapRequestStatus.ACCEPTED);
    expect(eventPublisher.recordSwapExecuted).toHaveBeenCalledWith(manager, {
      tenantId: TENANT_ID,
      swapRequestId: SWAP_ID,
      initiatorEmployeeId: INITIATOR_ID,
      initiatorShiftId: 'initiator-shift-1',
      targetEmployeeId: RESPONDER_ID,
      targetShiftId: 'target-shift',
      approvedBy: null,
    });
    expect(engagement.recordEvent).toHaveBeenCalledTimes(2);
    expect(engagement.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, employeeId: INITIATOR_ID, referenceId: SWAP_ID }),
    );
    expect(engagement.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, employeeId: RESPONDER_ID, referenceId: SWAP_ID }),
    );
  });
});
