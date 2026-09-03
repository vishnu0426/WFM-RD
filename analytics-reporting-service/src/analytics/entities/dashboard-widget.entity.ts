import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * §2.1 - unchanged in shape from the source spec. `dashboardId` references
 * `SavedReport.id` (application layer enforces `reportType = 'dashboard'`
 * on that row - see `saved-report.entity.ts`'s own doc comment).
 * `metricId` references `MetricDefinition.id`; a widget backed by a metric
 * with `estimatedCostTier = 'expensive'` must be rejected at write time
 * once Phase 5's validation pipeline exists (§0.5/§2.3 rule 2) - not
 * enforced yet in this phase.
 */
@Entity({ name: 'dashboard_widget', schema: 'analytics' })
export class DashboardWidget {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'dashboard_id' })
  dashboardId!: string;

  @Column('varchar', { name: 'widget_type' })
  widgetType!: string;

  @Column('uuid', { name: 'metric_id' })
  metricId!: string;

  @Column('jsonb', { name: 'position' })
  position!: Record<string, unknown>;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;
}
