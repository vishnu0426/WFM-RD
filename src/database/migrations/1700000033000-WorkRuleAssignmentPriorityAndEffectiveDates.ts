import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * User Management audit GAP-05: the reference's "Assignment Rules" concept
 * has no standalone entity anywhere in this schema, and building a
 * disconnected rule-engine table with no defined semantics would be pure
 * invention. The closest real, coherent fit is `WorkRuleAssignment` itself —
 * today it's a bare binding with no way to say *which* rule wins when an
 * employee ends up under two (one direct, one via a group they belong to,
 * or two groups), and no way to schedule a binding's own effective window
 * independent of the `WorkRule`'s. Adding `priority` (higher wins) and
 * `effective_from`/`effective_to` gives assignment resolution real,
 * queryable behavior instead of an undefined tie.
 */
export class WorkRuleAssignmentPriorityAndEffectiveDates1700000033000 implements MigrationInterface {
  name = 'WorkRuleAssignmentPriorityAndEffectiveDates1700000033000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE org.work_rule_assignments
        ADD COLUMN priority       integer NOT NULL DEFAULT 0,
        ADD COLUMN effective_from date,
        ADD COLUMN effective_to   date;
    `);
    // The original grant (`1700000023000`) only covered SELECT/INSERT/DELETE
    // — re-assigning an *already-bound* (workRuleId, assigneeType,
    // assigneeId) now updates its priority/effective window instead of
    // no-op'ing (WorkRulesService.assign), the first code path that ever
    // needs to UPDATE this table.
    await queryRunner.query(`GRANT UPDATE ON org.work_rule_assignments TO agno_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE UPDATE ON org.work_rule_assignments FROM agno_app;`);
    await queryRunner.query(`
      ALTER TABLE org.work_rule_assignments
        DROP COLUMN priority,
        DROP COLUMN effective_from,
        DROP COLUMN effective_to;
    `);
  }
}
