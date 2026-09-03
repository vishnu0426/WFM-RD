import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Thin wrapper over `prom-client`'s `Registry`, same posture as every other
 * service's `MetricsService` in this platform - `getRegistry()` is
 * available for anything not exposed here directly.
 *
 * §0.5's three real SLOs have nothing to measure yet in Phase 1 (no claim
 * flow, no guardrail calls, no subscription until Phase 2). The histograms
 * are declared here now, with their SLOs documented inline, so Phase 2's
 * claim handler has proven metrics to record into rather than inventing
 * naming/bucket conventions under phase pressure later - same "real but not
 * yet wired" posture every prior module's Phase 1 metrics followed.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly registry = new Registry();

  readonly httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  /**
   * §0.5's signature UX SLO: claim lock acquisition -> lose/win response,
   * p99 < 100ms. Wired in Phase 2 - unused until then.
   */
  readonly claimLockAcquisitionDuration = new Histogram({
    name: 'marketplace_claim_lock_acquisition_duration_seconds',
    help: "Redis distributed lock acquisition latency for a claim attempt - this module's §0.5 SLO (p99 < 100ms)",
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [this.registry],
  });

  /**
   * §0.5: guardrail validation (gRPC to Module 02/04), p99 < 500ms. Wired in
   * Phase 2 - unused until then.
   */
  readonly guardrailValidationDuration = new Histogram({
    name: 'marketplace_guardrail_validation_duration_seconds',
    help: "Module 02/04 guardrail validation gRPC round-trip latency - this module's §0.5 SLO (p99 < 500ms)",
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5],
    registers: [this.registry],
  });

  /**
   * §0.5: `marketplacePostUpdated` subscription push, p99 < 500ms from
   * status change. Wired in Phase 2 - unused until then.
   */
  readonly subscriptionPushDuration = new Histogram({
    name: 'marketplace_subscription_push_duration_seconds',
    help: "marketplacePostUpdated push latency from status change - this module's §0.5 SLO (p99 < 500ms)",
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5],
    registers: [this.registry],
  });

  /**
   * §5.2: "distinguish this in logging/metrics from legitimate high-frequency
   * use" - the `result` label is what makes this readable as an abuse signal
   * rather than just a raw request-volume counter. `rate_limited` is its own
   * distinct value (not folded into `rejected`), so a spike here reads
   * unambiguously as "the limiter is firing," not "guardrail rejections are
   * up." Wired in Phase 6 (`ClaimOpenShiftService`).
   */
  readonly claimAttemptsTotal = new Counter({
    name: 'marketplace_claim_attempts_total',
    help: "Open-shift claim attempts by outcome - result=rate_limited is this module's §5.2 anti-abuse signal, distinct from legitimate lock-contention/guardrail-rejection outcomes",
    labelNames: ['result'],
    registers: [this.registry],
  });

  /**
   * §7's own disclosed gap: Redis-down was only ever visible via
   * `GET /readyz` (pull, on whatever cadence a k8s probe happens to poll)
   * or by reading logs for a `MarketplaceRedisUnavailableError`. Set from
   * `MarketplaceRedisService.ping()` on every readiness check, and pushed to
   * `0` immediately from `acquireClaimLock`'s own failure path (the module's
   * actual concurrency-safety mechanism failing is worth a push, not just a
   * pull) - whichever of the two observes the outage first wins, since both
   * write the same gauge.
   */
  readonly redisUp = new Gauge({
    name: 'marketplace_redis_up',
    help: '1 if the last Redis check succeeded, 0 otherwise - Redis is this module’s concurrency-safety mechanism (§4), not a cache',
    registers: [this.registry],
  });

  /**
   * §7's own disclosed gap: `ClaimApproved`/`SwapExecuted` publish failures
   * were previously logged (`MarketplaceEventPublisherService`'s own
   * `logger.warn`) and nothing else - no metric a dashboard/alert could key
   * off. Labeled by `subject` so a stuck claim-approval publish and a stuck
   * swap-execution publish read as distinct signals, not one blended rate.
   */
  readonly natsPublishDuration = new Histogram({
    name: 'marketplace_nats_publish_duration_seconds',
    help: 'MarketplaceNatsClientService.publish latency by subject',
    labelNames: ['subject'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly natsPublishTotal = new Counter({
    name: 'marketplace_nats_publish_total',
    help: 'MarketplaceNatsClientService.publish attempts by subject and result',
    labelNames: ['subject', 'result'],
    registers: [this.registry],
  });

  /**
   * §7's own disclosed gap: `BidCloseSweepService`'s `@Cron` tick had no
   * metric at all - a wedged/crashing sweep (the job that's now also the
   * only path to a bid actually becoming an assignment, ADR-0159) would be
   * silent until someone noticed bids never converting. `outcome` labels
   * how the tick went, `closed`/`errored` labels how many opportunities the
   * tick closed vs. failed to close - both are counters, not a single
   * ambiguous "ticks" number.
   */
  readonly bidCloseSweepTicksTotal = new Counter({
    name: 'marketplace_bid_close_sweep_ticks_total',
    help: 'BidCloseSweepService.sweepTick executions, by whether the candidate query itself succeeded',
    labelNames: ['outcome'],
    registers: [this.registry],
  });

  readonly bidCloseSweepOpportunitiesTotal = new Counter({
    name: 'marketplace_bid_close_sweep_opportunities_total',
    help: 'Bid opportunities processed by BidCloseSweepService, by whether closeBidOpportunity succeeded',
    labelNames: ['outcome'],
    registers: [this.registry],
  });

  /**
   * Shift Marketplace Manager View phase: required by
   * `AccessTokenGuard`/`PermissionsGuard`/`TenantTokenMatchGuard`, same
   * reason value set every other service's own copy uses.
   */
  readonly rbacDenialsTotal = new Counter({
    name: 'marketplace_rbac_denials_total',
    help: 'RBAC guard rejections, by reason',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  /**
   * Shift Marketplace Manager View phase, §5 of the frontend prompt: the
   * health dashboard's "lock contention rate" signal - incremented inside
   * `MarketplaceRedisService.acquireClaimLock` (the module's single choke
   * point for every "exactly one concurrent winner" lock, shared by
   * claims/swaps/bid-close conversions) whenever the lock is already held.
   * Previously only visible as a `PostAlreadyBeingClaimedError`/
   * `SwapAlreadyBeingRespondedToError` thrown back to the caller, with no
   * aggregate signal a dashboard could read.
   */
  readonly lockContentionTotal = new Counter({
    name: 'marketplace_lock_contention_total',
    help: 'Claim/swap lock acquisition attempts that lost the race (MarketplaceRedisService.acquireClaimLock returning null)',
    registers: [this.registry],
  });

  /**
   * Shift Marketplace Manager View phase, §5: the health dashboard's
   * "guardrail pass/fail rate" signal - incremented inside
   * `GuardrailValidationService.checkEligibility`, the module's own
   * documented single choke point for every guardrail check (a real claim,
   * a read-only `eligibleForMe` resolution, `proposeSwap`/`respondToSwap`,
   * `submitBid`, and bid-close re-validation all go through this one
   * method). `unavailable` is distinct from `fail` - a gRPC/infra failure
   * is not the same signal as a legitimate ineligibility.
   */
  readonly guardrailValidationTotal = new Counter({
    name: 'marketplace_guardrail_validation_total',
    help: 'GuardrailValidationService.checkEligibility outcomes (pass/fail/unavailable)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  onModuleInit(): void {
    collectDefaultMetrics({ register: this.registry });
  }

  getRegistry(): Registry {
    return this.registry;
  }

  observeHttpRequest(method: string, route: string, statusCode: number, durationSeconds: number): void {
    this.httpRequestDuration.observe({ method, route, status_code: String(statusCode) }, durationSeconds);
  }

  recordRbacDenial(reason: 'unauthenticated' | 'forbidden_permission' | 'forbidden_tenant_mismatch'): void {
    this.rbacDenialsTotal.inc({ reason });
  }
}
