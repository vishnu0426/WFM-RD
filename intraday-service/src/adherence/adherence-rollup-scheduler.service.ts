import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../database/migrator-pool.provider';
import { ON_SHIFT_ACTIVITY } from '../schedule/scheduled-activity.service';

/** Trailing window re-aggregated on every tick, not the whole table - bounded, incremental, catches late-arriving events without a full scan. */
const HOURLY_WINDOW_HOURS = 2;
const DAILY_WINDOW_DAYS = 2;

const HOURLY_ROLLUP_SQL = `
  INSERT INTO intraday.adherence_hourly_rollup
    (tenant_id, employee_id, bucket_start, total_events, non_adherent_events, total_deviation_seconds)
  SELECT
    tenant_id,
    employee_id,
    date_trunc('hour', "timestamp") AS bucket_start,
    COUNT(*) AS total_events,
    COUNT(*) FILTER (WHERE scheduled_activity IS DISTINCT FROM $2) AS non_adherent_events,
    COALESCE(SUM(deviation_seconds), 0) AS total_deviation_seconds
  FROM intraday.adherence_event
  WHERE "timestamp" >= $1
  GROUP BY tenant_id, employee_id, date_trunc('hour', "timestamp")
  ON CONFLICT (tenant_id, employee_id, bucket_start) DO UPDATE SET
    total_events = EXCLUDED.total_events,
    non_adherent_events = EXCLUDED.non_adherent_events,
    total_deviation_seconds = EXCLUDED.total_deviation_seconds;
`;

const DAILY_ROLLUP_SQL = `
  INSERT INTO intraday.adherence_daily_rollup
    (tenant_id, employee_id, bucket_start, total_events, non_adherent_events, total_deviation_seconds)
  SELECT
    tenant_id,
    employee_id,
    date_trunc('day', "timestamp") AS bucket_start,
    COUNT(*) AS total_events,
    COUNT(*) FILTER (WHERE scheduled_activity IS DISTINCT FROM $2) AS non_adherent_events,
    COALESCE(SUM(deviation_seconds), 0) AS total_deviation_seconds
  FROM intraday.adherence_event
  WHERE "timestamp" >= $1
  GROUP BY tenant_id, employee_id, date_trunc('day', "timestamp")
  ON CONFLICT (tenant_id, employee_id, bucket_start) DO UPDATE SET
    total_events = EXCLUDED.total_events,
    non_adherent_events = EXCLUDED.non_adherent_events,
    total_deviation_seconds = EXCLUDED.total_deviation_seconds;
`;

/**
 * §3.4/ADR-0066: the pre-aggregation strategy "standing up from day one,"
 * not retrofitted once raw-partition query performance becomes a problem.
 * No `pg_cron`/materialized-view precedent exists anywhere in this
 * platform - an app-level `@Cron` upsert, matching
 * `ShiftStartPreloadSchedulerService`'s established shape (Phase 2), not a
 * new infra dependency.
 *
 * Uses the migrator-credentialed pool (`migrator-pool.provider.ts`): this
 * job aggregates *every* tenant's events in one tick, and RLS's `ENABLE`
 * (not `FORCE`) posture means only the table owner queries across tenants
 * without per-request scoping - see that provider's own doc comment.
 *
 * GAP-11 (enterprise readiness audit, 2026-08-18) - READ BEFORE ADDING A
 * CONSUMER: `non_adherent_events`/`total_events` here are event *counts*,
 * not time-weighted. `adherence-compliance-service`'s own daily rollup
 * (`adherence-daily-rollup-job.service.ts`) computes `AdherenceScore.adherencePct`
 * as `adherent_seconds / total_scheduled_seconds` - duration-weighted, per
 * the employee's real IANA timezone. A flurry of short state-change events
 * during one long deviation, versus one long steady deviation, produce very
 * different `non_adherent_events` counts for the same actual time out of
 * adherence - so `1 - non_adherent_events/total_events` computed from this
 * table is NOT the same number as Module 08's `adherencePct` for the same
 * employee/period, and will not agree with it. Nothing in this repository
 * currently exposes a percentage derived from this table to any caller
 * (verified: no gRPC method, resolver, or REST controller in this service
 * reads `adherence_hourly_rollup`/`adherence_daily_rollup`) - if you are
 * adding the first one, either (a) surface these counts as-is, clearly
 * labeled as event counts, not a percentage, or (b) treat
 * adherence-compliance-service's `AdherenceScore` as the one authoritative
 * percentage and query/proxy it instead of deriving a second one here. Do
 * not silently introduce a second "adherence %" - see the audit's
 * cross-module data-consistency finding for the full reasoning.
 */
@Injectable()
export class AdherenceRollupSchedulerService {
  private readonly logger = new Logger(AdherenceRollupSchedulerService.name);
  private ticking = false;

  constructor(@Inject(MIGRATOR_PG_POOL) private readonly pool: Pool) {}

  @Cron('0 * * * *')
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const hourlyWindowStart = new Date(Date.now() - HOURLY_WINDOW_HOURS * 60 * 60 * 1000);
      const dailyWindowStart = new Date(Date.now() - DAILY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      await this.pool.query(HOURLY_ROLLUP_SQL, [hourlyWindowStart, ON_SHIFT_ACTIVITY]);
      await this.pool.query(DAILY_ROLLUP_SQL, [dailyWindowStart, ON_SHIFT_ACTIVITY]);
    } catch (err) {
      this.logger.error(`Rollup tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
