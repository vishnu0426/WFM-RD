import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `org.time_bank_entries` — banked/comp-time ledger per employee ("Time
 * Banks" in the reference console's own menu). See `TimeBankEntry`'s own
 * doc comment (`src/modules/employee/entities/time-bank-entry.entity.ts`)
 * for the signed-ledger design. Same tenant-scoped-table shape as every
 * other `org`-schema table — standard RLS tenant-isolation policy,
 * `agno_app` grant, no DELETE (an append-only ledger; a correction is a
 * new offsetting entry, not an edit to history).
 */
export class TimeBankEntriesSchema1700000021000 implements MigrationInterface {
  name = 'TimeBankEntriesSchema1700000021000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;
    const platformAdminExpr = `current_setting('app.is_platform_admin', true) = 'true'`;

    await queryRunner.query(`
      CREATE TABLE org.time_bank_entries (
        id           uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id    uuid NOT NULL,
        employee_id  uuid NOT NULL,
        hours        numeric(7,2) NOT NULL,
        reason       varchar(255) NOT NULL,
        entry_date   date NOT NULL,
        created_by   uuid,
        created_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_time_bank_entries_tenant_id_employee_id
      ON org.time_bank_entries (tenant_id, employee_id);
    `);

    await queryRunner.query(`ALTER TABLE org.time_bank_entries ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON org.time_bank_entries FOR ALL
      USING (${platformAdminExpr} OR tenant_id = ${tenantIdExpr})
      WITH CHECK (${platformAdminExpr} OR tenant_id = ${tenantIdExpr});
    `);

    await queryRunner.query(`
      GRANT SELECT, INSERT ON org.time_bank_entries TO agno_app;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS org.time_bank_entries;`);
  }
}
