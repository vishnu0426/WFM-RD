import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum SavedReportType {
  DASHBOARD = 'dashboard',
  SCHEDULED_EXPORT = 'scheduled_export',
  AD_HOC = 'ad_hoc',
}

/**
 * §2.1 - unchanged in shape from the source spec except `name` (Phase 4,
 * see the migration that adds it - §4.1's `Dashboard` GraphQL type needs
 * one; §2.1's own DDL never listed one). `sharedWith` is a list of
 * role/user IDs *meant* to be resolved against Module 01's RBAC/ABAC on
 * every access (§2.3 rule 3) - Phase 4 does not implement that resolution
 * yet (no Module 01 RBAC client exists in this service); `myDashboards`/
 * `dashboard(id)` currently authorize on `createdBy` only. Named gap, see
 * `docs/module-09-phase-4-production-readiness-checklist.md`.
 * `DashboardWidget.dashboardId` (below) points at rows here where
 * `reportType = 'dashboard'`; that constraint is enforced at the
 * application layer (`DashboardService`), not a DB-level CHECK across
 * tables.
 */
@Entity({ name: 'saved_report', schema: 'analytics' })
export class SavedReport {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'created_by' })
  createdBy!: string;

  @Column('varchar', { name: 'name' })
  name!: string;

  @Column('varchar', { name: 'report_type' })
  reportType!: SavedReportType;

  @Column('jsonb', { name: 'config' })
  config!: Record<string, unknown>;

  @Column('varchar', { name: 'schedule_cron', nullable: true })
  scheduleCron!: string | null;

  @Column('jsonb', { name: 'shared_with', default: () => "'[]'::jsonb" })
  sharedWith!: unknown[];

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'updated_at' })
  updatedAt!: Date;
}
