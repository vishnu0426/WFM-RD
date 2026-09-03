import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdherenceDailyRollup, AdherenceEvent, AdherenceException, AdherenceHourlyRollup } from '../database/entities';
import { migratorPoolProvider } from '../database/migrator-pool.provider';
import { AdherenceCalculatorConsumerService } from './adherence-calculator.consumer';
import { AdherenceExceptionQueryService } from './adherence-exception-query.service';
import { AdherenceExceptionRestController } from './adherence-exception-rest.controller';
import { AdherenceExceptionService } from './adherence-exception.service';
import { AdherencePartitionSchedulerService } from './adherence-partition-scheduler.service';
import { AdherenceRollupSchedulerService } from './adherence-rollup-scheduler.service';

/**
 * §8 Phase 3: `AdherenceEvent` partitioned writes, deviation calculation,
 * the §3.4 rollup-table strategy. `AdherenceException` (added later)
 * shares this module - it's written by the same
 * `AdherenceCalculatorConsumerService`, not a separate pipeline.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AdherenceEvent, AdherenceException, AdherenceHourlyRollup, AdherenceDailyRollup]),
  ],
  controllers: [AdherenceExceptionRestController],
  providers: [
    migratorPoolProvider,
    AdherenceCalculatorConsumerService,
    AdherenceExceptionService,
    AdherenceExceptionQueryService,
    AdherenceRollupSchedulerService,
    AdherencePartitionSchedulerService,
  ],
})
export class AdherenceModule {}
