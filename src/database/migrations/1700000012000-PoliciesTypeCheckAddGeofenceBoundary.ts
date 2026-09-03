import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 11 Phase 6 (§5b, docs/adr/0155): `core.policies`' `policies_type_check`
 * CHECK constraint (`1700000011000-PoliciesTypeCheckConsolidationFix.ts`)
 * replaces the entire allowed-value list rather than adding to it - so
 * adding `PolicyType.GEOFENCE_BOUNDARY` requires a real migration here,
 * not just the TS enum change. Same consolidate-to-the-full-list style as
 * `1700000011000` (which itself exists because a still-earlier migration
 * silently dropped values by doing the same DROP+ADD without including
 * everything already accumulated) - this migration's own list is the
 * previous 11 values plus the one new one, so it cannot repeat that bug.
 */
export class PoliciesTypeCheckAddGeofenceBoundary1700000012000 implements MigrationInterface {
  name = 'PoliciesTypeCheckAddGeofenceBoundary1700000012000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.policies DROP CONSTRAINT policies_type_check;`);
    await queryRunner.query(`
      ALTER TABLE core.policies ADD CONSTRAINT policies_type_check CHECK (
        policy_type IN (
          'overtime_rule', 'break_rule', 'approval_chain', 'data_retention', 'rate_limit', 'auth_method_policy',
          'overtime_threshold', 'rest_period_minimum', 'max_consecutive_days', 'union_rule', 'skill_decay_half_life'
        )
      );
    `);
  }
}
