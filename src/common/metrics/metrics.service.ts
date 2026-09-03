import { Injectable, OnModuleInit } from '@nestjs/common';
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { CoreOutboxEventsRepository } from '../../modules/core-eventing/repositories/outbox-events.repository';
import { PendingAuditEventsRepository } from '../../modules/audit/repositories/pending-audit-events.repository';
import { WebhookDeliveriesRepository } from '../../modules/webhook/repositories/webhook-deliveries.repository';
import { NotificationDeliveryRepository } from '../../modules/notification/repositories/notification-delivery.repository';

/**
 * Phase 7 (§1's observability requirement, ADR-0050). A thin wrapper over
 * `prom-client`'s default `Registry` - not a leaky abstraction (same
 * posture as `RedisService`): callers that need a metric type this class
 * doesn't expose can still reach the registry directly via `getRegistry()`.
 *
 * Queue-depth gauges (`core_outbox_events_unpublished`,
 * `core_pending_audit_events`, `core_webhook_deliveries_pending`) use
 * `prom-client`'s `collect()` callback - the underlying COUNT query only
 * runs when `/metrics` is actually scraped, not on a separate timer, so
 * scrape frequency directly controls query load rather than adding a second
 * independent polling loop on top of the ones `CoreOutboxPublisherService`/
 * `AuditEventBatcherService`/`WebhookDeliveryDispatcherService` already run.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly registry = new Registry();

  readonly httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP/GraphQL request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP/GraphQL requests',
    labelNames: ['method', 'route', 'status_code'],
    registers: [this.registry],
  });

  constructor(
    private readonly outboxEvents: CoreOutboxEventsRepository,
    private readonly pendingAuditEvents: PendingAuditEventsRepository,
    private readonly webhookDeliveries: WebhookDeliveriesRepository,
    private readonly notificationDeliveries: NotificationDeliveryRepository,
  ) {}

  onModuleInit(): void {
    collectDefaultMetrics({ register: this.registry });

    // Captured via closure, not `this` inside `collect()` - prom-client
    // calls `collect` with `this` bound to the Gauge instance itself, not
    // this service.
    const outboxEventsRepo = this.outboxEvents;
    const pendingAuditEventsRepo = this.pendingAuditEvents;
    const webhookDeliveriesRepo = this.webhookDeliveries;
    const notificationDeliveriesRepo = this.notificationDeliveries;

    new Gauge({
      name: 'core_outbox_events_unpublished',
      help: 'Rows in core.outbox_events with published_at IS NULL - depth of the AuditEvent/PolicyChanged -> NATS pipeline (ADR-0039)',
      registers: [this.registry],
      async collect() {
        this.set(await outboxEventsRepo.countUnpublished());
      },
    });

    new Gauge({
      name: 'core_pending_audit_events',
      help: "Rows in core.pending_audit_events - depth of AuditEventBatcherService's durable queue (ADR-0042)",
      registers: [this.registry],
      async collect() {
        this.set(await pendingAuditEventsRepo.count());
      },
    });

    new Gauge({
      name: 'core_webhook_deliveries_pending',
      help: "Rows in core.webhook_deliveries with status=pending - depth of WebhookDeliveryDispatcherService's queue (ADR-0046)",
      registers: [this.registry],
      async collect() {
        this.set(await webhookDeliveriesRepo.countPending());
      },
    });

    // GAP-05 fix (enterprise readiness audit, 2026-08-18): depth of
    // NotificationDeliveryDispatcherService's queue, same shape as the
    // webhook gauge above.
    new Gauge({
      name: 'core_notification_delivery_pending',
      help: "Rows in core.notification_delivery with status=pending - depth of NotificationDeliveryDispatcherService's queue",
      registers: [this.registry],
      async collect() {
        this.set(await notificationDeliveriesRepo.countPending());
      },
    });
  }

  getRegistry(): Registry {
    return this.registry;
  }

  observeHttpRequest(method: string, route: string, statusCode: number, durationSeconds: number): void {
    const labels = { method, route, status_code: String(statusCode) };
    this.httpRequestDuration.observe(labels, durationSeconds);
    this.httpRequestsTotal.inc(labels);
  }
}
