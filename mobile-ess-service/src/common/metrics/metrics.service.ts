import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Thin wrapper over `prom-client`'s `Registry`, same posture as every other
 * service's `MetricsService` in this platform. `recordRbacDenial` is
 * required by `AccessTokenGuard`/`TenantTokenMatchGuard` (copied from
 * ai-layer-service, docs/adr/0130). `recordSyncAction`/
 * `recordSyncBatchDuration` are this phase's own cross-cutting deliverable
 * ("offline queue depth distribution at sync time, sync conflict rate by
 * action type" - source spec §6).
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

  /** Guard rejections, by reason (unauthenticated/forbidden_tenant_mismatch) - recorded directly inside the guards themselves, since Guards run before Interceptors in NestJS's request lifecycle. */
  readonly rbacDenialsTotal = new Counter({
    name: 'mobile_ess_rbac_denials_total',
    help: 'RBAC guard rejections, by reason',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  /** Per-action sync outcome, by action_type and resulting status (synced/conflict/failed). */
  readonly syncActionsTotal = new Counter({
    name: 'mobile_offline_sync_actions_total',
    help: 'Offline action queue sync outcomes, by action_type and status',
    labelNames: ['action_type', 'status'],
    registers: [this.registry],
  });

  /** Batch size actually seen at sync time - the offline-queue-depth-distribution deliverable. */
  readonly syncBatchSize = new Histogram({
    name: 'mobile_offline_sync_batch_size',
    help: 'Number of actions in each POST /v1/mobile/sync batch',
    buckets: [1, 2, 5, 10, 20, 30, 50],
    registers: [this.registry],
  });

  /** Phase 5 (ADR-0154), the §0.5 on-call deliverable: "push notification
   * delivery failure rate exceeding a threshold... delivering to a dead/
   * expired token at scale" - an external Prometheus/Alertmanager rule
   * thresholds on this, not built in this repo (same posture as every
   * other service's own metrics-only, alerting-is-ops-config split). */
  readonly pushDeliveryAttemptsTotal = new Counter({
    name: 'mobile_push_delivery_attempts_total',
    help: 'Push notification delivery attempts, by outcome',
    labelNames: ['outcome'],
    registers: [this.registry],
  });

  readonly pushDeadTokenTotal = new Counter({
    name: 'mobile_push_dead_token_total',
    help: 'DeviceRegistration rows marked inactive after an Expo DeviceNotRegistered response',
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

  recordRbacDenial(reason: 'unauthenticated' | 'forbidden_tenant_mismatch'): void {
    this.rbacDenialsTotal.inc({ reason });
  }

  recordSyncAction(actionType: string, status: 'synced' | 'conflict' | 'failed'): void {
    this.syncActionsTotal.inc({ action_type: actionType, status });
  }

  recordSyncBatchSize(size: number): void {
    this.syncBatchSize.observe(size);
  }

  recordPushDeliveryAttempt(
    outcome: 'sent' | 'failed' | 'skipped_no_device' | 'skipped_preference_disabled' | 'skipped_no_linked_user',
  ): void {
    this.pushDeliveryAttemptsTotal.inc({ outcome });
  }

  recordPushDeadToken(): void {
    this.pushDeadTokenTotal.inc();
  }
}
