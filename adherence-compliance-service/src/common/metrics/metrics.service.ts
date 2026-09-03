import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Thin wrapper over `prom-client`'s `Registry`, same posture as every other
 * service's `MetricsService` in this platform - `getRegistry()` is
 * available for anything not exposed here directly.
 *
 * §0.5's rollup-job-lag and SLO metrics have nothing to measure yet in
 * Phase 1 (no rollup job exists until Phase 3). The histogram/counter below
 * are declared here now, with the SLO they exist to watch documented
 * inline, so Phase 3's rollup runner has a proven metric to record into
 * rather than inventing naming/bucket conventions under phase pressure
 * later - same "real but not yet wired" posture every other service's
 * Phase 1 `MetricsService` followed for its own first-consumed-later metric.
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
   * §0.5's rollup SLO: a 15-minute rollup job run should complete within its
   * window (e.g. within 5 min of window close). Wired in Phase 3 - unused
   * until then. `period_type` distinguishes the 15-minute/daily/weekly tick,
   * since each carries its own SLO bound per §0.5's own table.
   */
  readonly rollupJobLagSeconds = new Histogram({
    name: 'compliance_rollup_job_lag_seconds',
    help: "Rollup job completion lag past its window close - this module's §0.5 SLO, watched per period_type",
    labelNames: ['period_type'],
    buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800],
    registers: [this.registry],
  });

  /** §0.5's rollup-job-failure page condition: run outcomes by period_type, wired in Phase 3. */
  readonly rollupJobRunsTotal = new Counter({
    name: 'compliance_rollup_job_runs_total',
    help: 'Rollup job run outcomes (success/error) by period_type',
    labelNames: ['period_type', 'result'],
    registers: [this.registry],
  });

  /** §6's governance metric: `ValidatePolicyAgainstFloor` rejection rate. Wired in Phase 4 - unused until then. */
  readonly validatePolicyAgainstFloorCallsTotal = new Counter({
    name: 'compliance_validate_policy_against_floor_calls_total',
    help: 'ValidatePolicyAgainstFloor gRPC call outcomes (valid/rejected/error) - a governance metric worth watching, not just a debugging aid',
    labelNames: ['result'],
    registers: [this.registry],
  });

  /** §6's governance metric: a rule was activated despite a flagged non-compliant preview. Wired in Phase 5 - unused until then. */
  readonly impactPreviewFlaggedButActivatedTotal = new Counter({
    name: 'compliance_impact_preview_flagged_but_activated_total',
    help: 'Count of activateComplianceRule calls where the RuleChangeImpactPreview had flagged non-compliant schedules - not blocked, but never silent',
    registers: [this.registry],
  });

  /** Phase 2: createComplianceRule outcomes. */
  readonly complianceRuleCreationsTotal = new Counter({
    name: 'compliance_rule_creations_total',
    help: 'createComplianceRule outcomes (accepted/rejected/error)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  /** Phase 2: activateComplianceRule outcomes. */
  readonly complianceRuleActivationsTotal = new Counter({
    name: 'compliance_rule_activations_total',
    help: 'activateComplianceRule outcomes (activated/rejected/error)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  /** Phase 6: generateComplianceReport outcomes, by report type. */
  readonly complianceReportGenerationsTotal = new Counter({
    name: 'compliance_report_generations_total',
    help: 'generateComplianceReport outcomes (completed/failed) by report_type',
    labelNames: ['report_type', 'result'],
    registers: [this.registry],
  });

  /**
   * Enterprise readiness audit (2026-08-18), GAP-03 fix: fires whenever
   * `auditAgainstRule` finds at least one `ComplianceRule` row for a
   * (jurisdiction, ruleType) but none of them resolves for the report's
   * requested `asOf` date - a real gap in this jurisdiction's rule
   * coverage, not the ordinary "no rule ever configured for this ruleType"
   * case (which never increments this counter). The report still
   * generates (a header-only table for that rule type, same as before this
   * fix), but this is the loud signal `resolveEffectiveRules`'s own fix
   * doesn't otherwise produce on its own - an operator/compliance team
   * should treat a nonzero rate here as "close this rule-coverage gap,"
   * not silence.
   */
  readonly complianceRuleUnresolvedForReportTotal = new Counter({
    name: 'compliance_rule_unresolved_for_report_total',
    help: 'Report generation found ComplianceRule history for a (jurisdiction, ruleType) but none covered the requested asOf date',
    labelNames: ['rule_type'],
    registers: [this.registry],
  });

  /** Phase 7 (docs/adr/0106): the retention lifecycle job's own run outcome, same shape as the rollup jobs'. */
  readonly retentionLifecycleJobRunsTotal = new Counter({
    name: 'compliance_retention_lifecycle_job_runs_total',
    help: 'Retention lifecycle job run outcomes (success/error)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  /** Phase 7: reports actually deleted (or failed to delete) by the retention lifecycle job, per tick. */
  readonly retentionLifecycleDeletionsTotal = new Counter({
    name: 'compliance_retention_lifecycle_deletions_total',
    help: 'compliance_report rows deleted by the retention lifecycle job (deleted/error)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  /** ADR-0161: this module's first RBAC signal - denials by reason, same shape as every other RBAC-gated service's identical metric. */
  readonly rbacDenialsTotal = new Counter({
    name: 'compliance_rbac_denials_total',
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

  observeRollupJobLag(periodType: 'fifteen_minute' | 'daily' | 'weekly', lagSeconds: number): void {
    this.rollupJobLagSeconds.observe({ period_type: periodType }, lagSeconds);
  }

  recordRollupJobRun(periodType: 'fifteen_minute' | 'daily' | 'weekly', result: 'success' | 'error'): void {
    this.rollupJobRunsTotal.inc({ period_type: periodType, result });
  }

  recordValidatePolicyAgainstFloorCall(result: 'valid' | 'rejected' | 'error'): void {
    this.validatePolicyAgainstFloorCallsTotal.inc({ result });
  }

  recordImpactPreviewFlaggedButActivated(): void {
    this.impactPreviewFlaggedButActivatedTotal.inc();
  }

  recordComplianceRuleCreation(result: 'accepted' | 'rejected' | 'error'): void {
    this.complianceRuleCreationsTotal.inc({ result });
  }

  recordComplianceRuleActivation(result: 'activated' | 'rejected' | 'error'): void {
    this.complianceRuleActivationsTotal.inc({ result });
  }

  recordComplianceReportGeneration(reportType: string, result: 'completed' | 'failed'): void {
    this.complianceReportGenerationsTotal.inc({ report_type: reportType, result });
  }

  recordComplianceRuleUnresolvedForReport(ruleType: string): void {
    this.complianceRuleUnresolvedForReportTotal.inc({ rule_type: ruleType });
  }

  recordRetentionLifecycleJobRun(result: 'success' | 'error'): void {
    this.retentionLifecycleJobRunsTotal.inc({ result });
  }

  recordRetentionLifecycleDeletion(result: 'deleted' | 'error'): void {
    this.retentionLifecycleDeletionsTotal.inc({ result });
  }

  recordRbacDenial(reason: 'unauthenticated' | 'forbidden_permission' | 'forbidden_tenant_mismatch'): void {
    this.rbacDenialsTotal.inc({ reason });
  }
}
