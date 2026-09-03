import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes ADR-0150's `userId -> Employee` gap (the reverse-lookup half):
 * `Employee.userId` has been settable since Module 02 Phase 1
 * (`1700000001000-Module02OrgEmployeeSchema.ts`), but nothing ever
 * prevented two `Employee` rows from pointing at the same `User` - a real
 * data-integrity gap once `EmployeesRepository.findByUserId` starts being
 * relied on to answer "which employee is this session." Partial (`WHERE
 * user_id IS NOT NULL`) because most employees legitimately have no
 * linked user yet (headcount-only/onboarding-in-progress, §2.2 rule 2) -
 * a plain unique index would incorrectly reject a second `NULL`.
 */
export class EmployeesUserIdUniqueIndex1700000013000 implements MigrationInterface {
  name = 'EmployeesUserIdUniqueIndex1700000013000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_employees_tenant_id_user_id
      ON org.employees (tenant_id, user_id)
      WHERE user_id IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS org.uq_employees_tenant_id_user_id;`);
  }
}
