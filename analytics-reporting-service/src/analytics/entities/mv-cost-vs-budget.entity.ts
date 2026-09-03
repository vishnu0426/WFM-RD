import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Phase 3 (ADR-0109): despite the table's name, holds **hours and days,
 * never a dollar figure** - no pay-rate/budget capability exists anywhere
 * in this platform. See ADR-0109 for the full reasoning; see the migration
 * that creates this table for the exact join. Written by
 * `MvCostVsBudgetRefreshJobService` via `MIGRATOR_PG_POOL` raw SQL, not
 * this entity's own repository - this class exists for Phase 4's
 * `agno_analytics_app`-scoped query-engine reads.
 */
@Entity({ name: 'mv_cost_vs_budget', schema: 'analytics_mv' })
export class MvCostVsBudget {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { name: 'cost_center' })
  costCenter!: string;

  @Column('timestamptz', { name: 'period_start' })
  periodStart!: Date;

  @Column('timestamptz', { name: 'period_end' })
  periodEnd!: Date;

  @Column('numeric', { name: 'scheduled_hours' })
  scheduledHours!: string;

  @Column('numeric', { name: 'overtime_hours' })
  overtimeHours!: string;

  @Column('numeric', { name: 'approved_leave_days' })
  approvedLeaveDays!: string;

  @Column('timestamptz', { name: 'computed_at' })
  computedAt!: Date;
}
