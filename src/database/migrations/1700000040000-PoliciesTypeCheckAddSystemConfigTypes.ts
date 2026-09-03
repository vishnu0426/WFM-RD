import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * System Configuration gap-fix: `core.policies`' `policies_type_check`
 * CHECK constraint replaces the entire allowed-value list rather than
 * adding to it (see `1700000012000-PoliciesTypeCheckAddGeofenceBoundary.ts`'s
 * own doc comment) — adding `PolicyType.ACCESS_RESTRICTION_POLICY`/
 * `SYSTEM_LIMITS`/`MAINTENANCE_MODE` requires a real migration here, not
 * just the TS enum change (found live: `POST /v1/policies` 500'd with
 * Postgres error 23514 on `policies_type_check` before this migration ran).
 * This migration's list is the previous 12 values plus the 3 new ones.
 */
export class PoliciesTypeCheckAddSystemConfigTypes1700000040000 implements MigrationInterface {
  name = 'PoliciesTypeCheckAddSystemConfigTypes1700000040000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.policies DROP CONSTRAINT policies_type_check;`);
    await queryRunner.query(`
      ALTER TABLE core.policies ADD CONSTRAINT policies_type_check CHECK (
        policy_type IN (
          'overtime_rule', 'break_rule', 'approval_chain', 'data_retention', 'rate_limit', 'auth_method_policy',
          'overtime_threshold', 'rest_period_minimum', 'max_consecutive_days', 'union_rule', 'skill_decay_half_life',
          'geofence_boundary', 'access_restriction_policy', 'system_limits', 'maintenance_mode'
        )
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.policies DROP CONSTRAINT policies_type_check;`);
    await queryRunner.query(`
      ALTER TABLE core.policies ADD CONSTRAINT policies_type_check CHECK (
        policy_type IN (
          'overtime_rule', 'break_rule', 'approval_chain', 'data_retention', 'rate_limit', 'auth_method_policy',
          'overtime_threshold', 'rest_period_minimum', 'max_consecutive_days', 'union_rule', 'skill_decay_half_life',
          'geofence_boundary'
        )
      );
    `);
  }
}
