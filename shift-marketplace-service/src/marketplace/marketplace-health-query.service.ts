import { Injectable } from '@nestjs/common';
import { MetricsService } from '../common/metrics/metrics.service';

export interface MarketplaceMetricCount {
  label: string;
  count: number;
}

export interface MarketplaceHealthSnapshot {
  lockContentionTotal: number;
  guardrailValidationByResult: MarketplaceMetricCount[];
  claimAttemptsByResult: MarketplaceMetricCount[];
}

/**
 * Shift Marketplace Manager View phase, §5 of the frontend prompt: reads
 * current cumulative values straight off `MetricsService`'s in-process
 * `prom-client` registry - not a historical trend (no time-series store
 * exists anywhere in this platform). This is deliberately the simplest
 * thing that gives the frontend real, non-fabricated numbers rather than
 * an invented chart shape.
 */
@Injectable()
export class MarketplaceHealthQueryService {
  constructor(private readonly metrics: MetricsService) {}

  async snapshot(): Promise<MarketplaceHealthSnapshot> {
    const [lockContention, guardrailValidation, claimAttempts] = await Promise.all([
      this.metrics.lockContentionTotal.get(),
      this.metrics.guardrailValidationTotal.get(),
      this.metrics.claimAttemptsTotal.get(),
    ]);

    return {
      lockContentionTotal: lockContention.values[0]?.value ?? 0,
      guardrailValidationByResult: guardrailValidation.values.map((v) => ({
        label: String(v.labels.result ?? 'unknown'),
        count: v.value,
      })),
      claimAttemptsByResult: claimAttempts.values.map((v) => ({
        label: String(v.labels.result ?? 'unknown'),
        count: v.value,
      })),
    };
  }
}
