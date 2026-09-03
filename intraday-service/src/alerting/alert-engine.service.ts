import { Injectable } from '@nestjs/common';
import { QueueLiveStateRecord } from '../redis/types';
import { AlertPipelineService } from './alert-pipeline.service';
import { AlertSeverity } from './entities/alert.entity';

/** Design doc assumption 6: the only detector built this phase - §5a's own example is queue-focused. */
export const SERVICE_LEVEL_BREACH_ALERT_TYPE = 'service_level_breach';

/** More than 20% below target counts as critical, not just a warning - a simple, defensible threshold, not a fabricated precise formula. */
const CRITICAL_DEFICIT_RATIO = 0.2;

/**
 * §5's own architecture walkthrough example: "a queue breaching its
 * service-level target." Called from `QueueMetricsUpdatedConsumerService`
 * (Phase 4) right after its existing Redis write - the raw
 * threshold-breach detector that feeds `AlertPipelineService`'s dedup/
 * suppression/escalation stage, kept structurally separate from it per
 * §5a point 4.
 */
@Injectable()
export class AlertEngineService {
  constructor(private readonly pipeline: AlertPipelineService) {}

  async evaluateQueueMetrics(tenantId: string, queueId: string, record: QueueLiveStateRecord): Promise<void> {
    if (record.serviceLevelCurrent === null || record.serviceLevelTarget === null) {
      return;
    }

    if (record.serviceLevelCurrent < record.serviceLevelTarget) {
      await this.pipeline.raiseAlert({
        tenantId,
        alertType: SERVICE_LEVEL_BREACH_ALERT_TYPE,
        queueId,
        severity: this.computeSeverity(record.serviceLevelCurrent, record.serviceLevelTarget),
      });
    } else {
      await this.pipeline.resolveAlert(tenantId, queueId, SERVICE_LEVEL_BREACH_ALERT_TYPE);
    }
  }

  private computeSeverity(current: number, target: number): AlertSeverity {
    const deficitRatio = (target - current) / target;
    return deficitRatio > CRITICAL_DEFICIT_RATIO ? 'critical' : 'warning';
  }
}
