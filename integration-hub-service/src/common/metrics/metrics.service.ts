import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Thin wrapper over `prom-client`'s `Registry`, same posture as every other
 * service's `MetricsService` in this platform - `getRegistry()` is
 * available for anything not exposed here directly.
 *
 * §0.5's two SLOs for this module have nothing to measure yet in Phase 1
 * (no sync runner, no relay, no webhook dispatcher until Phase 3/6/7). Both
 * histograms are declared here now, with their SLO documented inline, so
 * those phases inherit settled metric name/bucket conventions instead of
 * inventing them under phase pressure later - same "real but not yet wired"
 * posture every prior module's Phase 1 metrics followed.
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

  readonly httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
    registers: [this.registry],
  });

  /**
   * §0.5's streaming SLO: p95 relay-event-received-to-forwarded-to-Module-05
   * latency < 200ms. Wired in Phase 6 (first ACD connector, §5c) - unused
   * until then.
   */
  readonly relayForwardDuration = new Histogram({
    name: 'integration_hub_relay_forward_duration_seconds',
    help: "ACD relay event-received-to-forwarded-to-Module-05 latency - this module's streaming §0.5 SLO (p95 < 200ms)",
    labelNames: ['provider'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2],
    registers: [this.registry],
  });

  /**
   * §0.5's batch SLO: per-provider sync job p95 completion within its
   * scheduled window. Wired in Phase 3 (first HRIS connector) - unused
   * until then. `provider` label, not a single cross-platform bucket set,
   * since §0.5 states this SLO is scoped per-provider, not platform-wide.
   */
  readonly syncJobDuration = new Histogram({
    name: 'integration_hub_sync_job_duration_seconds',
    help: "Batch SyncJob completion duration by provider - this module's batch §0.5 SLO (p95 within scheduled window, sized per provider)",
    labelNames: ['provider', 'sync_type', 'status'],
    buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600],
    registers: [this.registry],
  });

  /**
   * §5a: "surface rate-limit-driven delays distinctly from actual
   * failures." `kind` distinguishes the proactive throttle (never even
   * called the provider this tick) from a reactive one (the provider
   * itself returned a rate-limit response despite the proactive throttle,
   * and backoff/retry still didn't recover in time).
   */
  readonly rateLimitThrottlesTotal = new Counter({
    name: 'integration_hub_rate_limit_throttles_total',
    help: 'Count of batch sync attempts throttled by provider rate limiting, by provider and kind (proactive/reactive_exhausted)',
    labelNames: ['provider', 'kind'],
    registers: [this.registry],
  });

  /**
   * Phase 8's RBAC pass (own copy of ai-layer-service's ADR-0130 metric,
   * itself named by that phase's own disclosed gap: "Guards run *before*
   * `HttpMetricsInterceptor`... no counter anywhere for RBAC denials." A
   * 401/403 thrown by `AccessTokenGuard`/`PermissionsGuard`/
   * `TenantTokenMatchGuard` never reaches that interceptor at all, so this
   * is the only place this module can observe a denial - closed here from
   * the start rather than left as a first disclosed-then-later-fixed gap.
   */
  readonly rbacDenialsTotal = new Counter({
    name: 'integration_hub_rbac_denials_total',
    help: 'RBAC guard rejections, by reason (unauthenticated/forbidden_permission/forbidden_tenant_mismatch)',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  /** §7 Phase 8: outcome of each real webhook delivery attempt - the dashboard-visible counterpart to `WebhookDelivery.retry_count`/`deliveredAt`. */
  readonly webhookDeliveriesTotal = new Counter({
    name: 'integration_hub_webhook_deliveries_total',
    help: 'Count of webhook delivery attempts, by outcome (delivered/failed)',
    labelNames: ['outcome'],
    registers: [this.registry],
  });

  onModuleInit(): void {
    collectDefaultMetrics({ register: this.registry });
  }

  getRegistry(): Registry {
    return this.registry;
  }

  observeHttpRequest(method: string, route: string, statusCode: number, durationSeconds: number): void {
    const labels = { method, route, status_code: String(statusCode) };
    this.httpRequestDuration.observe(labels, durationSeconds);
    this.httpRequestsTotal.inc(labels);
  }

  observeRelayForward(provider: string, durationSeconds: number): void {
    this.relayForwardDuration.observe({ provider }, durationSeconds);
  }

  observeSyncJobDuration(provider: string, syncType: string, status: string, durationSeconds: number): void {
    this.syncJobDuration.observe({ provider, sync_type: syncType, status }, durationSeconds);
  }

  recordRateLimitThrottle(provider: string, kind: 'proactive' | 'reactive_exhausted' | 'reactive_retry'): void {
    this.rateLimitThrottlesTotal.inc({ provider, kind });
  }

  recordRbacDenial(
    reason: 'unauthenticated' | 'forbidden_permission' | 'forbidden_tenant_mismatch' | 'forbidden_not_platform_admin',
  ): void {
    this.rbacDenialsTotal.inc({ reason });
  }

  recordWebhookDelivery(outcome: 'delivered' | 'failed'): void {
    this.webhookDeliveriesTotal.inc({ outcome });
  }
}
