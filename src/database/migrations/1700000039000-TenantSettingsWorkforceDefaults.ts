import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * System Configuration gap-fix: real, persisted, validated storage for
 * Scheduling/Forecasting/Time & Attendance numeric defaults — but NOT yet
 * consumed by scheduling-service/forecasting-service/attendance-leave-service.
 * This session's audit confirmed those three services cannot read
 * `core.tenant_settings` today by deliberate, ADR-documented schema-isolation
 * design (ADR-0052/ADR-0017/ADR-0073 — separate least-privilege DB roles per
 * service, no cross-schema grants), and root's gRPC surface has no
 * `TenantSettingsService` RPC yet (only `PolicyService.GetActivePolicy` is a
 * real precedent for the shape such an RPC would need). Wiring that up is
 * real, bounded, net-new cross-service work — three new gRPC client modules
 * — deliberately not attempted alongside this round's other gap-fixes to
 * avoid inventing solver/forecast logic that doesn't exist yet. Disclosed
 * as BACKEND GAP in the UI, not silently implied to already affect output.
 */
export class TenantSettingsWorkforceDefaults1700000039000 implements MigrationInterface {
  name = 'TenantSettingsWorkforceDefaults1700000039000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.tenant_settings
        ADD COLUMN scheduling_interval_minutes integer,
        ADD COLUMN planning_period_weeks integer,
        ADD COLUMN default_shift_duration_hours numeric(4,2),
        ADD COLUMN forecasting_interval_minutes integer,
        ADD COLUMN historical_data_window_weeks integer,
        ADD COLUMN forecasting_planning_horizon_weeks integer,
        ADD COLUMN attendance_grace_period_minutes integer;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.tenant_settings
        DROP COLUMN IF EXISTS scheduling_interval_minutes,
        DROP COLUMN IF EXISTS planning_period_weeks,
        DROP COLUMN IF EXISTS default_shift_duration_hours,
        DROP COLUMN IF EXISTS forecasting_interval_minutes,
        DROP COLUMN IF EXISTS historical_data_window_weeks,
        DROP COLUMN IF EXISTS forecasting_planning_horizon_weeks,
        DROP COLUMN IF EXISTS attendance_grace_period_minutes;
    `);
  }
}
