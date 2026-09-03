import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Thin wrapper over `prom-client`'s `Registry`, same posture as every other
 * service's `MetricsService` in this platform - `getRegistry()` is
 * available for anything not exposed here directly.
 *
 * §7's cross-cutting deliverable list for this module names four
 * observability signals beyond generic HTTP metrics: materialized-view
 * refresh lag per view, read-replica lag, query cost-tier distribution, and
 * consistency-check discrepancy rate. All four were declared in Phase 1,
 * before any of the jobs/paths that record into them existed - the first
 * two are wired for real as of Phase 2 (`RefreshModule`'s jobs and
 * `MvFreshnessMonitorService`); `metricQueriesTotal`/
 * `consistencyCheckDiscrepanciesTotal` remain declared-not-wired until
 * Phase 4/8 respectively. Same "real but not yet wired" posture every
 * other service's Phase 1 `MetricsService` already follows, now with two
 * of the four graduated.
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
   * §0.5/on-call: page when a view's refresh lags past its own documented
   * cadence (e.g. a daily view with no successful refresh in >36h). Wired
   * in Phase 2/3 alongside the refresh runner; `view_name` matches the
   * `mv_lineage.view_name` this view's row documents.
   */
  readonly mvRefreshLagSeconds = new Gauge({
    name: 'analytics_mv_refresh_lag_seconds',
    help: "Seconds since a materialized view's last successful refresh, minus its documented cadence - this module's §0.5 staleness SLO, watched per view_name",
    labelNames: ['view_name'],
    registers: [this.registry],
  });

  readonly mvRefreshJobRunsTotal = new Counter({
    name: 'analytics_mv_refresh_job_runs_total',
    help: 'Materialized-view refresh job runs by view_name and outcome (completed/failed)',
    labelNames: ['view_name', 'result'],
    registers: [this.registry],
  });

  /**
   * §0.5/on-call: page when replica lag exceeds a threshold that would make
   * `dataAsOf` misleadingly stale. Wired in Phase 2 alongside the replica
   * connection.
   */
  readonly replicaLagSeconds = new Gauge({
    name: 'analytics_replica_lag_seconds',
    help: 'Streaming replication lag of the analytics read replica behind the shared agno_wfm primary',
    registers: [this.registry],
  });

  /**
   * §0.5's query cost-tier distribution signal. Wired in Phase 4
   * (`MetricQueryEngineService.query`) - every `metricQuery`/`executiveSummary`/
   * BI-connector read records here, labeled by the *definition's own*
   * `estimated_cost_tier`, not a per-call measurement.
   */
  readonly metricQueriesTotal = new Counter({
    name: 'analytics_metric_queries_total',
    help: 'metricQuery/dashboard/BI-connector reads by estimated_cost_tier and result',
    labelNames: ['cost_tier', 'result'],
    registers: [this.registry],
  });

  /**
   * §0.5/§2.3 rule 2/ADR-0110: `createMetricDefinition`'s dry-run/cost-
   * tiering gate outcomes. `cost_tier` is only present for a `'validated'`
   * result (the tier the dry-run actually measured); a `'rejected'` result
   * (whitelist-legal but dry-run failed, or not whitelist-legal at all)
   * has no tier to report. Wired in Phase 5.
   */
  readonly metricDefinitionValidationsTotal = new Counter({
    name: 'analytics_metric_definition_validations_total',
    help: "createMetricDefinition's dry-run validation outcomes, by result (validated/rejected) and cost_tier (empty for rejected)",
    labelNames: ['result', 'cost_tier'],
    registers: [this.registry],
  });

  /**
   * §4.2/§1: `POST /v1/analytics/exports`'s fire-and-forget generation
   * outcomes. Wired in Phase 6.
   */
  readonly analyticsExportsTotal = new Counter({
    name: 'analytics_exports_total',
    help: 'POST /v1/analytics/exports fire-and-forget generation outcomes, by result (completed/failed)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  /**
   * §2.3 rule 4/on-call: a materialized view's aggregate disagreeing with a
   * fresh read of its source tables is an alerting condition, not a silent
   * discrepancy. Wired in Phase 8's consistency-check job.
   */
  readonly consistencyCheckDiscrepanciesTotal = new Counter({
    name: 'analytics_consistency_check_discrepancies_total',
    help: 'Consistency-check job findings where a materialized view sample disagreed with a fresh source read, by view_name',
    labelNames: ['view_name'],
    registers: [this.registry],
  });

  /** ADR-0163: this module's first RBAC signal - denials by reason, same shape as every other RBAC-gated service's identical metric. */
  readonly rbacDenialsTotal = new Counter({
    name: 'analytics_rbac_denials_total',
    help: 'RBAC guard denials by reason (unauthenticated/forbidden_permission/forbidden_tenant_mismatch)',
    labelNames: ['reason'],
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

  recordRbacDenial(
    reason: 'unauthenticated' | 'forbidden_permission' | 'forbidden_tenant_mismatch' | 'forbidden_not_platform_admin',
  ): void {
    this.rbacDenialsTotal.inc({ reason });
  }
}
