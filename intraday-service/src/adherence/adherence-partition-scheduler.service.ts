import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../database/migrator-pool.provider';
import { addDays, partitionBounds, retentionCutoffPartitionName } from './partition-naming';

/** §3.4: "hot partitions for 90 days" - a small safety buffer past that before actually dropping one. */
const RETENTION_DAYS = 95;
/** Create tomorrow's *and* the day after's partition, so a slow/missed tick still leaves one day of buffer. */
const CREATE_AHEAD_DAYS = 2;

/**
 * §3.4/ADR-0066: the automated partition-creation job the spec explicitly
 * asks for (a stricter bar than `audit_log`/`forecast_data_points`, which
 * both defer rotation to `pg_partman` as an accepted gap) - daily
 * partitions age out roughly 30x faster than monthly ones, and
 * `adherence_event` has no `DEFAULT` partition, so deferring this the same
 * way would mean writes start failing within about a week of go-live.
 *
 * Uses the migrator-credentialed pool (`migrator-pool.provider.ts`) -
 * partition creation/drop is DDL, which the runtime `agno_intraday_app`
 * role deliberately cannot do (no `CREATE` grant on `intraday`).
 */
@Injectable()
export class AdherencePartitionSchedulerService {
  private readonly logger = new Logger(AdherencePartitionSchedulerService.name);
  private ticking = false;

  constructor(@Inject(MIGRATOR_PG_POOL) private readonly pool: Pool) {}

  @Cron('0 1 * * *')
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.createUpcomingPartitions();
      await this.dropExpiredPartitions();
    } catch (err) {
      this.logger.error(`Partition maintenance tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async createUpcomingPartitions(): Promise<void> {
    const today = new Date();
    for (let offset = 0; offset <= CREATE_AHEAD_DAYS; offset++) {
      const { name, start, end } = partitionBounds(addDays(today, offset));
      const existing = await this.pool.query(
        `SELECT 1 FROM pg_class WHERE relname = $1 AND relnamespace = 'intraday'::regnamespace`,
        [name],
      );
      if (existing.rowCount === 0) {
        // `name` is our own computed YYYY_MM_DD-derived identifier, never
        // user input - safe to interpolate; Postgres DDL doesn't accept
        // parameterized identifiers the way DML accepts parameterized
        // values. `start`/`end` ARE passed as real bind parameters.
        await this.pool.query(
          `CREATE TABLE intraday."${name}" PARTITION OF intraday.adherence_event FOR VALUES FROM ($1) TO ($2)`,
          [start, end],
        );
        this.logger.log(`Created adherence_event partition ${name} [${start}, ${end})`);
      }
    }
  }

  private async dropExpiredPartitions(): Promise<void> {
    const cutoffName = retentionCutoffPartitionName(new Date(), RETENTION_DAYS);
    const result = await this.pool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'intraday.adherence_event'::regclass
         AND c.relname < $1`,
      [cutoffName],
    );
    for (const row of result.rows) {
      await this.pool.query(`DROP TABLE intraday."${row.relname}"`);
      this.logger.log(
        `Dropped expired adherence_event partition ${row.relname} (retention: ${RETENTION_DAYS}d) - already captured in the rollup tables`,
      );
    }
  }
}
