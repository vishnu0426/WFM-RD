import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { ANALYTICS_APP_REPLICA_PG_POOL } from '../database/analytics-app-replica-pool.provider';
import { withTenantScopedClient } from '../database/with-tenant-scoped-client';
import { MetricsService } from '../common/metrics/metrics.service';
import { MetricCostTier } from './entities/metric-definition.entity';
import { SOURCE_VIEW_REGISTRY } from './source-view-registry';
import { MetricSourceNotAllowedError } from './errors/metric-not-found.error';
import { MetricValidationFailedError } from './errors/metric-validation-failed.error';

export interface CalculationDefinition {
  sourceView: string;
  valueColumn: string;
  dimensions?: string[];
}

export interface ValidationResult {
  validatedAt: Date;
  estimatedCostTier: MetricCostTier;
}

// Disclosed placeholder thresholds (ADR-0110), not load-tested constants -
// every whitelisted source view is a pre-computed, tenant-id-indexed
// rollup table, so nothing on file today should ever measure past 'cheap'.
// Revisit with Phase 8's real load-test numbers, not a guess made here.
const CHEAP_THRESHOLD_MS = 100;
const MODERATE_THRESHOLD_MS = 1000;
const DRY_RUN_SAMPLE_SIZE = 5;

/**
 * Phase 5 (§0.5/§2.3 rule 2, ADR-0110): the dry-run/cost-tiering gate every
 * tenant-authored `MetricDefinition` passes through at creation time
 * (`MetricDefinitionService.createMetricDefinition`). Reuses
 * `SOURCE_VIEW_REGISTRY` - the exact whitelist `MetricQueryEngineService`
 * already checks at query time - so there is one whitelist, checked
 * twice, never two that could drift apart.
 *
 * The dry-run itself runs the real read path (`ANALYTICS_APP_REPLICA_PG_POOL`/
 * `withTenantScopedClient`, RLS-scoped) at a small, fixed `LIMIT` - a
 * definition that is whitelist-legal but fails at runtime for any other
 * reason is rejected here, not discovered on a dashboard's first real load.
 */
@Injectable()
export class MetricValidationService {
  constructor(
    @Inject(ANALYTICS_APP_REPLICA_PG_POOL) private readonly replicaPool: Pool,
    private readonly metrics: MetricsService,
  ) {}

  async validateAndTier(
    tenantId: string,
    metricName: string,
    calculationDefinition: CalculationDefinition,
  ): Promise<ValidationResult> {
    const spec = SOURCE_VIEW_REGISTRY[calculationDefinition.sourceView];
    if (!spec || !spec.allowedValueColumns.includes(calculationDefinition.valueColumn)) {
      this.metrics.metricDefinitionValidationsTotal.inc({ result: 'rejected', cost_tier: '' });
      throw new MetricSourceNotAllowedError(metricName);
    }
    for (const dimension of calculationDefinition.dimensions ?? []) {
      if (!spec.allowedDimensions.includes(dimension)) {
        this.metrics.metricDefinitionValidationsTotal.inc({ result: 'rejected', cost_tier: '' });
        throw new MetricSourceNotAllowedError(metricName);
      }
    }

    const start = process.hrtime.bigint();
    try {
      await withTenantScopedClient(this.replicaPool, tenantId, (client) =>
        client.query(
          `SELECT ${calculationDefinition.valueColumn} FROM ${spec.table} ORDER BY period_start DESC LIMIT ${DRY_RUN_SAMPLE_SIZE};`,
          [],
        ),
      );
    } catch (err) {
      this.metrics.metricDefinitionValidationsTotal.inc({ result: 'rejected', cost_tier: '' });
      throw new MetricValidationFailedError((err as Error).message);
    }
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

    const estimatedCostTier = classifyCostTier(durationMs);
    this.metrics.metricDefinitionValidationsTotal.inc({ result: 'validated', cost_tier: estimatedCostTier });
    return { validatedAt: new Date(), estimatedCostTier };
  }
}

function classifyCostTier(durationMs: number): MetricCostTier {
  if (durationMs < CHEAP_THRESHOLD_MS) {
    return MetricCostTier.CHEAP;
  }
  if (durationMs < MODERATE_THRESHOLD_MS) {
    return MetricCostTier.MODERATE;
  }
  return MetricCostTier.EXPENSIVE;
}
