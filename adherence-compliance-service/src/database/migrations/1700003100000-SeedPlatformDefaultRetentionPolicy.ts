import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 08 Phase 7 (§5b, docs/adr/0106): the first real row `retention_policy`
 * has ever had - Phase 1 built the table, nothing seeded it. One
 * platform-default (`tenant_id: NULL`) row, jurisdiction `US`,
 * `retention_years: 3` - a deliberately minimal seed, not a legal
 * database. §5b's own framing ("needs periodic legal review, it isn't a
 * permanent hardcoded fact") governs the choice directly: asserting
 * confident retention periods for many jurisdictions this session has no
 * authority to certify would be worse than seeding one clearly-a-starting-
 * point row and leaving every other jurisdiction on
 * `ComplianceReportService`'s own disclosed 7-year hardcoded fallback
 * (Phase 6).
 */
export class SeedPlatformDefaultRetentionPolicy1700003100000 implements MigrationInterface {
  name = 'SeedPlatformDefaultRetentionPolicy1700003100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO compliance.retention_policy (id, tenant_id, jurisdiction, retention_years, created_at)
      VALUES (gen_random_uuid(), NULL, 'US', 3, now());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM compliance.retention_policy WHERE tenant_id IS NULL AND jurisdiction = 'US';
    `);
  }
}
