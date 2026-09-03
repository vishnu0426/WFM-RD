import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Thin wrapper over `prom-client`'s `Registry`, same posture as
 * `IntradayRedisService`/root's `RedisService` - not a leaky abstraction,
 * `getRegistry()` is available for anything not exposed here directly.
 *
 * §7's cross-cutting observability ask names "Redis write latency
 * distribution" and "NATS consumer lag per subject" specifically for this
 * module. Phase 1 delivered the former (`redisOperationDuration`) and an
 * ingestion-outcome counter; consumer lag had no meaning until Phase 2 had a
 * consumer to lag. Phase 7 closes that gap (`natsConsumerLag`) and adds
 * `redisUp` - a proactive signal `RedisHeartbeatService` populates, since
 * before Phase 7 nothing showed up in `/metrics` about Redis health unless a
 * request happened to touch Redis during an outage.
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

  readonly ingestionEventsTotal = new Counter({
    name: 'intraday_ingestion_events_total',
    help: 'Activity-event webhook ingestion outcomes (§0.5 SLO: p99 < 100ms webhook receipt to Redis write)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  readonly redisOperationDuration = new Histogram({
    name: 'intraday_redis_operation_duration_seconds',
    help: "IntradayRedisService operation duration - §0's Redis write-path latency SLO",
    labelNames: ['operation'],
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [this.registry],
  });

  readonly natsPublishDuration = new Histogram({
    name: 'intraday_nats_publish_duration_seconds',
    help: 'IntradayNatsClientService.publish duration, by subject prefix',
    labelNames: ['subject'],
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [this.registry],
  });

  /** Phase 7: `RedisHeartbeatService`'s proactive ping result - 1 = up, 0 = down. Distinct from `redisOperationDuration`: a gauge can be "currently down" between scrapes, a histogram can't. */
  readonly redisUp = new Gauge({
    name: 'intraday_redis_up',
    help: "RedisHeartbeatService's most recent ping result (1 = up, 0 = down)",
    registers: [this.registry],
  });

  /** Phase 7: closes §7's "NATS consumer lag per subject" ask, flagged as a gap since Phase 1 - `num_pending` per durable consumer, from `NatsConsumerLagMonitorService`. */
  readonly natsConsumerLag = new Gauge({
    name: 'intraday_nats_consumer_lag',
    help: 'Pending (undelivered) message count per durable JetStream consumer',
    labelNames: ['durable_name'],
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

  recordIngestionEvent(result: 'accepted' | 'duplicate' | 'invalid_signature' | 'upstream_unavailable'): void {
    this.ingestionEventsTotal.inc({ result });
  }

  observeRedisOperation(operation: string, durationSeconds: number): void {
    this.redisOperationDuration.observe({ operation }, durationSeconds);
  }

  observeNatsPublish(subject: string, durationSeconds: number): void {
    this.natsPublishDuration.observe({ subject }, durationSeconds);
  }

  setRedisUp(up: boolean): void {
    this.redisUp.set(up ? 1 : 0);
  }

  setNatsConsumerLag(durableName: string, numPending: number): void {
    this.natsConsumerLag.set({ durable_name: durableName }, numPending);
  }
}
