import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { SwapRequest, SwapRequestStatus } from './entities/swap-request.entity';
import { MarketplaceRedisService, MarketplaceRedisUnavailableError } from '../redis/redis.service';
import { GuardrailValidationService } from './guardrail-validation.service';
import { CONTENTION_LOCK_TTL_SECONDS } from './contention-lock.constants';
import { SwapRequestNotFoundError } from './errors/swap-request-not-found.error';
import { SwapRequestNotPendingError } from './errors/swap-request-not-pending.error';
import { NotYourSwapToRespondToError } from './errors/not-your-swap-to-respond-to.error';
import { SwapOfferedShiftRequiredError } from './errors/swap-offered-shift-required.error';
import { SwapAlreadyBeingRespondedToError } from './errors/swap-already-being-responded-to.error';
import { MarketplaceUnavailableError } from './errors/marketplace-unavailable.error';
import { MetricsService } from '../common/metrics/metrics.service';
import { TenantMarketplacePolicyService } from './tenant-marketplace-policy.service';
import { MarketplaceEventPublisherService } from './marketplace-event-publisher.service';
import { MarketplaceEngagementService } from './marketplace-engagement.service';
import { MarketplaceEngagementEventType } from './entities/marketplace-engagement-event.entity';

export interface ProposeSwapInput {
  tenantId: string;
  initiatorEmployeeId: string;
  initiatorShiftId: string;
  initiatorOrgUnitId: string;
  /** Both or neither - a closed swap names its target up front; an open swap leaves both null until `respondToSwap`. */
  targetEmployeeId?: string;
  targetShiftId?: string;
  targetOrgUnitId?: string;
}

export interface RespondToSwapInput {
  tenantId: string;
  swapRequestId: string;
  respondingEmployeeId: string;
  accept: boolean;
  /** Open swap only - what the accepting employee is offering in return. Ignored for a closed swap (its target shift was already named at `proposeSwap`). */
  offeredShiftId?: string;
  offeredOrgUnitId?: string;
}

/**
 * §8 Phase 3: `SwapRequest`'s peer-to-peer flow, reusing
 * `GuardrailValidationService` - the same guardrail path `ClaimOpenShiftService`
 * uses - rather than a separate implementation (§8's own instruction).
 *
 * A swap is really two simultaneous assignment changes, not one: accepting
 * exchanges the initiator's shift for the target's. Both directions get
 * their own real guardrail check (ADR-0087) - "would the initiator be
 * eligible for the target's shift" and "would the target be eligible for
 * the initiator's shift" - each excluding the checked employee's own
 * given-up shift so it doesn't self-conflict against the trade it's part
 * of.
 */
@Injectable()
export class SwapRequestService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: MarketplaceRedisService,
    private readonly guardrailValidation: GuardrailValidationService,
    private readonly metrics: MetricsService,
    private readonly tenantPolicy: TenantMarketplacePolicyService,
    private readonly eventPublisher: MarketplaceEventPublisherService,
    private readonly engagement: MarketplaceEngagementService,
  ) {}

  async findById(tenantId: string, swapRequestId: string): Promise<SwapRequest | null> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(SwapRequest, { where: { id: swapRequestId, tenantId } }),
    );
  }

  async proposeSwap(input: ProposeSwapInput): Promise<SwapRequest> {
    return withTenantConnection(this.dataSource, input.tenantId, async (manager) => {
      const swap = manager.create(SwapRequest, {
        id: randomUUID(),
        tenantId: input.tenantId,
        initiatorEmployeeId: input.initiatorEmployeeId,
        initiatorShiftId: input.initiatorShiftId,
        initiatorOrgUnitId: input.initiatorOrgUnitId,
        targetEmployeeId: input.targetEmployeeId ?? null,
        targetShiftId: input.targetShiftId ?? null,
        targetOrgUnitId: input.targetOrgUnitId ?? null,
        status: SwapRequestStatus.PENDING,
        requiresSupervisorApproval: true,
        validationResult: null,
        createdAt: new Date(),
      });
      await manager.save(swap);
      return swap;
    });
  }

  async respondToSwap(input: RespondToSwapInput): Promise<SwapRequest> {
    if (!input.accept) {
      return this.reject(input.tenantId, input.swapRequestId, input.respondingEmployeeId);
    }

    // Same "exactly one concurrent winner" contention as the claim lock
    // (§4 step 1) - always taken, even for a closed swap (where it also
    // guards against the same named target double-submitting concurrently),
    // not just for the open-swap case where a race between two *different*
    // employees is possible.
    const lockStart = process.hrtime.bigint();
    let lockToken: string | null;
    try {
      lockToken = await this.redis.acquireClaimLock(input.tenantId, input.swapRequestId, CONTENTION_LOCK_TTL_SECONDS);
    } catch (err) {
      if (err instanceof MarketplaceRedisUnavailableError) {
        throw new MarketplaceUnavailableError();
      }
      throw err;
    } finally {
      this.metrics.claimLockAcquisitionDuration.observe(Number(process.hrtime.bigint() - lockStart) / 1e9);
    }

    if (lockToken === null) {
      throw new SwapAlreadyBeingRespondedToError(input.swapRequestId);
    }

    try {
      return await this.processAccept(input);
    } finally {
      await this.redis.releaseClaimLock(input.tenantId, input.swapRequestId, lockToken);
    }
  }

  private async reject(tenantId: string, swapRequestId: string, respondingEmployeeId: string): Promise<SwapRequest> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const swap = await manager.findOne(SwapRequest, { where: { id: swapRequestId, tenantId } });
      if (!swap) {
        throw new SwapRequestNotFoundError(swapRequestId);
      }
      if (swap.status !== SwapRequestStatus.PENDING) {
        throw new SwapRequestNotPendingError(swapRequestId, swap.status);
      }
      if (swap.targetEmployeeId === null || swap.targetEmployeeId !== respondingEmployeeId) {
        // An open swap (no named target) has no one specific to "reject" it
        // - the only meaningful response to an open swap is an accept, by
        // whoever gets there first.
        throw new NotYourSwapToRespondToError(swapRequestId);
      }
      swap.status = SwapRequestStatus.REJECTED;
      await manager.save(swap);
      return swap;
    });
  }

  private async processAccept(input: RespondToSwapInput): Promise<SwapRequest> {
    const { tenantId, swapRequestId, respondingEmployeeId } = input;

    const pending = await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const swap = await manager.findOne(SwapRequest, { where: { id: swapRequestId, tenantId } });
      if (!swap) {
        throw new SwapRequestNotFoundError(swapRequestId);
      }
      if (swap.status !== SwapRequestStatus.PENDING) {
        throw new SwapRequestNotPendingError(swapRequestId, swap.status);
      }
      if (swap.targetEmployeeId !== null && swap.targetEmployeeId !== respondingEmployeeId) {
        throw new NotYourSwapToRespondToError(swapRequestId);
      }

      const targetShiftId = swap.targetShiftId ?? input.offeredShiftId ?? null;
      const targetOrgUnitId = swap.targetOrgUnitId ?? input.offeredOrgUnitId ?? null;
      if (!targetShiftId || !targetOrgUnitId) {
        throw new SwapOfferedShiftRequiredError(swapRequestId);
      }

      // Resolve who/what this swap is actually trading - committed as its
      // own step, still `pending`, before the two gRPC guardrail calls
      // (same "commit the resolution, then validate" shape as
      // `ClaimOpenShiftService`'s `pending_validation` step, §4 step 2).
      //
      // GAP-01 (enterprise readiness audit, 2026-08-18): the Redis lock
      // above was this method's *only* protection against two different
      // employees both accepting the same open swap - a plain `save()`
      // here has no way to reject a second writer if the lock was
      // skipped/expired/lost to a partition. Fix: a conditional UPDATE
      // guarded by `target_employee_id IS NULL OR = respondingEmployeeId`
      // (in addition to `status = 'pending'`) - a second, *different*
      // responder's UPDATE affects 0 rows once the first has committed,
      // even under full concurrency, because Postgres re-evaluates this
      // WHERE clause against the committed row before either UPDATE can
      // proceed past the lock the other is holding.
      // TypeORM's `EntityManager.query()` returns `[rows, rowCount]` for an
      // UPDATE, even with RETURNING - not the rows array directly. See
      // `ClaimOpenShiftService.processClaim`'s identical fix for the full
      // explanation.
      const [resolvedRows]: [Array<{ id: string }>, number] = await manager.query(
        `
          UPDATE marketplace.swap_request
          SET target_employee_id = $1, target_shift_id = $2, target_org_unit_id = $3
          WHERE id = $4 AND tenant_id = $5 AND status = $6
            AND (target_employee_id IS NULL OR target_employee_id = $1)
          RETURNING id
        `,
        [respondingEmployeeId, targetShiftId, targetOrgUnitId, swapRequestId, tenantId, SwapRequestStatus.PENDING],
      );
      if (resolvedRows.length === 0) {
        throw new SwapAlreadyBeingRespondedToError(swapRequestId);
      }

      swap.targetEmployeeId = respondingEmployeeId;
      swap.targetShiftId = targetShiftId;
      swap.targetOrgUnitId = targetOrgUnitId;
      return swap;
    });

    let initiatorSide, responderSide;
    try {
      [initiatorSide, responderSide] = await Promise.all([
        this.guardrailValidation.checkEligibility({
          tenantId,
          candidateEmployeeId: pending.initiatorEmployeeId,
          shiftAssignmentId: pending.targetShiftId as string,
          orgUnitId: pending.targetOrgUnitId as string,
          excludeShiftAssignmentId: pending.initiatorShiftId,
        }),
        this.guardrailValidation.checkEligibility({
          tenantId,
          candidateEmployeeId: respondingEmployeeId,
          shiftAssignmentId: pending.initiatorShiftId,
          orgUnitId: pending.initiatorOrgUnitId,
          excludeShiftAssignmentId: pending.targetShiftId as string,
        }),
      ]);
    } catch (err) {
      // §0.5's guardrail-gRPC chaos scenario, same fix as
      // `ClaimOpenShiftService`: fail closed, mark rejected (a transient
      // reason) rather than leaving the swap stuck with a resolved target
      // and no verdict.
      await withTenantConnection(this.dataSource, tenantId, async (manager) => {
        const failedSwap = await manager.findOneOrFail(SwapRequest, { where: { id: swapRequestId, tenantId } });
        failedSwap.status = SwapRequestStatus.REJECTED;
        failedSwap.validationResult = { eligible: false, reason: 'guardrail_validation_unavailable' };
        await manager.save(failedSwap);
      });
      throw err;
    }

    const eligible =
      initiatorSide.shiftAssignmentFound &&
      initiatorSide.eligible &&
      responderSide.shiftAssignmentFound &&
      responderSide.eligible;

    const finalSwap = await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const finalSwap = await manager.findOneOrFail(SwapRequest, { where: { id: swapRequestId, tenantId } });
      // §0.5's progressive-delivery row, ADR-0089: auto-approval skips
      // straight to `accepted`; otherwise this stays `pending_approval`
      // until a supervisor calls `approveMarketplaceAction`. `!finalSwap.
      // requiresSupervisorApproval` has no way to become `false` via the
      // current `proposeSwap` API surface yet (always defaults `true`) -
      // wired now so a future mutation input can set it without touching
      // this decision again.
      const autoApproved =
        eligible && (this.tenantPolicy.isAutoApprovalEnabled(tenantId) || !finalSwap.requiresSupervisorApproval);
      const nextStatus = !eligible
        ? SwapRequestStatus.REJECTED
        : autoApproved
          ? SwapRequestStatus.ACCEPTED
          : SwapRequestStatus.PENDING_APPROVAL;
      const validationResult = {
        eligible,
        initiatorViolations: initiatorSide.shiftAssignmentFound
          ? initiatorSide.violations
          : [{ category: 'stale_shift', detail: 'the target shift no longer resolves' }],
        responderViolations: responderSide.shiftAssignmentFound
          ? responderSide.violations
          : [{ category: 'stale_shift', detail: 'the initiator shift no longer resolves' }],
      };

      // GAP-01: closes the same-named-target double-submit case the first
      // step's guard can't (that guard only rejects a *different*
      // responder - a legitimate target resubmitting concurrently passes
      // it every time, since `status` doesn't change there). Guarding this
      // decision write by `status = 'pending'` means only the first of any
      // concurrent decisions actually lands - the rest affect 0 rows
      // rather than each independently re-publishing `SwapExecuted`/
      // recording a duplicate engagement event below.
      // TypeORM's `EntityManager.query()` returns `[rows, rowCount]` for an
      // UPDATE, even with RETURNING - not the rows array directly. See
      // `ClaimOpenShiftService.processClaim`'s identical fix for the full
      // explanation.
      const [decidedRows]: [Array<{ id: string }>, number] = await manager.query(
        `
          UPDATE marketplace.swap_request
          SET status = $1, validation_result = $2
          WHERE id = $3 AND tenant_id = $4 AND status = $5
          RETURNING id
        `,
        [nextStatus, JSON.stringify(validationResult), swapRequestId, tenantId, SwapRequestStatus.PENDING],
      );
      if (decidedRows.length === 0) {
        throw new SwapAlreadyBeingRespondedToError(swapRequestId);
      }

      finalSwap.status = nextStatus;
      finalSwap.validationResult = validationResult;

      if (finalSwap.status === SwapRequestStatus.ACCEPTED) {
        // §4 step 7 analogue: the actual Module 04 handoff for a swap.
        //
        // GAP-02: recorded into the transactional outbox *inside* this
        // same transaction as the decision write above - see
        // `MarketplaceEventPublisherService`'s own doc comment.
        await this.eventPublisher.recordSwapExecuted(manager, {
          tenantId,
          swapRequestId: finalSwap.id,
          initiatorEmployeeId: finalSwap.initiatorEmployeeId,
          initiatorShiftId: finalSwap.initiatorShiftId,
          targetEmployeeId: finalSwap.targetEmployeeId as string,
          targetShiftId: finalSwap.targetShiftId as string,
          approvedBy: null,
        });
      }

      return finalSwap;
    });

    if (finalSwap.status === SwapRequestStatus.ACCEPTED) {
      // Phase 7 (ADR-0091): the auto-approval counterpart to
      // `ApproveMarketplaceActionService.approveSwap`'s own identical pair
      // of calls - both participants earn points, never double-fired for
      // the same swap since it reaches `accepted` through exactly one of
      // these two paths.
      await Promise.all([
        this.engagement.recordEvent({
          tenantId,
          employeeId: finalSwap.initiatorEmployeeId,
          eventType: MarketplaceEngagementEventType.SWAP_EXECUTED,
          referenceId: finalSwap.id,
        }),
        this.engagement.recordEvent({
          tenantId,
          employeeId: finalSwap.targetEmployeeId as string,
          eventType: MarketplaceEngagementEventType.SWAP_EXECUTED,
          referenceId: finalSwap.id,
        }),
      ]);
    }

    return finalSwap;
  }
}
