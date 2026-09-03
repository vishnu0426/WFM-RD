import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Real, pre-existing bug found and fixed while implementing Module 08
 * Phase 4 (docs/adr/0101): `1700000006000-Module01Phase3SsoSchema.ts`'s
 * `up()` does `DROP CONSTRAINT policies_type_check` + `ADD CONSTRAINT`
 * with only `('overtime_rule','break_rule','approval_chain','data_retention',
 * 'rate_limit','auth_method_policy')` - silently dropping the four
 * `EmploymentPolicy` types (`1700000001000-Module02OrgEmployeeSchema.ts`)
 * and `skill_decay_half_life` (`1700000002000-Module02SkillDecayJob.ts`)
 * that two earlier migrations had already added. Each of those three
 * migrations replaces the *entire* constraint rather than adding to it, so
 * whichever one runs last determines what's actually allowed - by
 * timestamp order, that was `1700000006000`'s narrower 6-type list, not
 * the fuller 10-type list `1700000002000` had already established. A
 * freshly-migrated database therefore silently rejects every
 * `EmploymentPolicy`/`skill_decay_half_life` write with a `CHECK` violation,
 * caught here only because Module 08 Phase 4 needed a real
 * `EmploymentPolicy` write path to test against `ValidatePolicyAgainstFloor`.
 *
 * Fix: consolidate to the full accumulated list, matching `PolicyType`
 * (the TS enum) exactly, all 11 values. `PolicyType` itself was never
 * wrong - only the DB constraint had drifted from it.
 */
export class PoliciesTypeCheckConsolidationFix1700000011000 implements MigrationInterface {
  name = 'PoliciesTypeCheckConsolidationFix1700000011000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restores exactly what 1700000006000 left in place - this migration's
    // own down() is a narrowing, not a schema removal; reverting to the
    // pre-fix (buggy) constraint is the correct symmetric undo.
    await queryRunner.query(`ALTER TABLE core.policies DROP CONSTRAINT policies_type_check;`);
    await queryRunner.query(`
      ALTER TABLE core.policies ADD CONSTRAINT policies_type_check CHECK (
        policy_type IN ('overtime_rule','break_rule','approval_chain','data_retention','rate_limit','auth_method_policy')
      );
    `);
  }
}
