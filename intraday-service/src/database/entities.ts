import { AdherenceDailyRollup } from '../adherence/entities/adherence-daily-rollup.entity';
import { AdherenceEvent } from '../adherence/entities/adherence-event.entity';
import { AdherenceException } from '../adherence/entities/adherence-exception.entity';
import { AdherenceHourlyRollup } from '../adherence/entities/adherence-hourly-rollup.entity';
import { AlertPolicy } from '../alerting/entities/alert-policy.entity';
import { Alert } from '../alerting/entities/alert.entity';
import { IngestionCredential } from '../ingestion-credentials/entities/ingestion-credential.entity';
import { QueueMetricsSnapshot } from '../live-state/entities/queue-metrics-snapshot.entity';
import { ReallocationAction } from '../reallocation/entities/reallocation-action.entity';
import { StaffingOffer } from '../staffing-offers/entities/staffing-offer.entity';

/**
 * Single source of truth for "every entity in this service," consumed by
 * both the NestJS `TypeOrmModule` registration and the CLI `DataSource`
 * used for migrations - same convention as the root app's own
 * `src/modules/entities.ts`.
 */
export const entities = [
  AdherenceEvent,
  AdherenceException,
  AdherenceHourlyRollup,
  AdherenceDailyRollup,
  Alert,
  AlertPolicy,
  ReallocationAction,
  QueueMetricsSnapshot,
  StaffingOffer,
  IngestionCredential,
];

export {
  AdherenceEvent,
  AdherenceException,
  AdherenceHourlyRollup,
  AdherenceDailyRollup,
  Alert,
  AlertPolicy,
  ReallocationAction,
  QueueMetricsSnapshot,
  StaffingOffer,
  IngestionCredential,
};
