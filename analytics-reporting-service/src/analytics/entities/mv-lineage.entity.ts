import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum MvRefreshCadence {
  HOURLY = 'hourly',
  DAILY = 'daily',
}

export enum MvLastRunStatus {
  SUCCESS = 'success',
  FAILED = 'failed',
}

/**
 * §0.6/§2.2 - the lineage record that keeps `analytics_mv` from becoming an
 * undocumented shadow warehouse. One row per materialized view this
 * service owns, documenting where its data actually comes from, how often
 * it is refreshed, and why it exists - not tenant data, so no `tenant_id`/
 * RLS (mirrors how this platform treats other schema-describing metadata,
 * e.g. `ComplianceRule`'s citation requirement being about the row's
 * *content*, not who owns the row).
 *
 * `refreshedAt`/`dataAsOf` are null until Phase 2/3's refresh runner exists
 * and actually populates the view this row describes - this table is
 * created in Phase 1 with all four planned views' lineage seeded (ADR-0108),
 * but no view object and no successful refresh yet. `dataAsOf` (distinct
 * from `refreshedAt`) is the timestamp surfaced to callers via §4.1's
 * `MetricResult.dataAsOf` / §2.3 rule 1 - the instant the underlying data
 * reflects, which for a daily view lags `refreshedAt` by however long the
 * refresh job itself takes to run.
 */
@Entity({ name: 'mv_lineage', schema: 'analytics_mv' })
export class MvLineage {
  @PrimaryColumn('varchar', { name: 'view_name' })
  viewName!: string;

  @Column('text', { name: 'source_description' })
  sourceDescription!: string;

  @Column('jsonb', { name: 'source_tables' })
  sourceTables!: Array<{ module: string; schema: string; table: string }>;

  @Column('varchar', { name: 'refresh_cadence' })
  refreshCadence!: MvRefreshCadence;

  @Column('text', { name: 'query_pattern_description' })
  queryPatternDescription!: string;

  @Column('timestamptz', { name: 'refreshed_at', nullable: true })
  refreshedAt!: Date | null;

  @Column('timestamptz', { name: 'data_as_of', nullable: true })
  dataAsOf!: Date | null;

  @Column('varchar', { name: 'last_run_status', nullable: true })
  lastRunStatus!: MvLastRunStatus | null;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;
}
