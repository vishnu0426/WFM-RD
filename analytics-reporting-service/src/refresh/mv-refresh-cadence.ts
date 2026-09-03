/**
 * Seconds-form of `MvRefreshCadence` (`mv-lineage.entity.ts`), for computing
 * `MetricsService.mvRefreshLagSeconds` (seconds past a view's documented
 * cadence). Both refresh job services below hardcode `'daily'`, matching
 * `SeedMvLineage`'s seeded value for their own view - if a future phase
 * changes a view's cadence (e.g. Phase 8's load test justifying hourly for
 * `mv_adherence_trend_rollup`), the `@Cron` schedule, this constant's
 * lookup, and `mv_lineage.refresh_cadence` must all move together; nothing
 * reads `mv_lineage.refresh_cadence` back out to drive the schedule itself.
 */
export const CADENCE_SECONDS: Record<'hourly' | 'daily', number> = {
  hourly: 60 * 60,
  daily: 24 * 60 * 60,
};
