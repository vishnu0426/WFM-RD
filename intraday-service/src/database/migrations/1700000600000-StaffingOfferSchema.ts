import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `intraday.staffing_offer` - detection + push-notification-trigger only
 * this phase (see `StaffingOfferService`'s own doc comment). Only
 * `status = 'offered'` is ever written - the CHECK constraint below is
 * deliberately a single allowed value rather than pre-declaring
 * `accepted`/`declined`/`expired` states nothing writes yet; widen it in a
 * follow-up migration when that lifecycle lands, same posture
 * `ReallocationSchema`'s status CHECK took once `reallocation_action`
 * actually grew a full lifecycle.
 */
export class StaffingOfferSchema1700000600000 implements MigrationInterface {
  name = 'StaffingOfferSchema1700000600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE intraday.staffing_offer (
        id            uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        queue_id      uuid NOT NULL,
        offer_type    varchar(20) NOT NULL,
        employee_id   uuid NOT NULL,
        reason        varchar(500) NOT NULL,
        status        varchar(20) NOT NULL DEFAULT 'offered',
        created_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT staffing_offer_offer_type_check CHECK (offer_type IN ('vto', 'overtime')),
        CONSTRAINT staffing_offer_status_check CHECK (status = 'offered'),
        PRIMARY KEY (id)
      );
    `);
    // The repeat-guard's own access pattern: "is there already an offer for this (tenant, queue, employee, offer_type)."
    await queryRunner.query(`
      CREATE INDEX idx_staffing_offer_tenant_queue_employee_type
      ON intraday.staffing_offer (tenant_id, queue_id, employee_id, offer_type);
    `);

    await queryRunner.query(`ALTER TABLE intraday.staffing_offer ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON intraday.staffing_offer FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
    `);

    // No UPDATE grant - nothing in this phase ever transitions a row's
    // status (there's only one status to be in). Add it alongside the
    // CHECK-constraint widening once accept/decline exists.
    await queryRunner.query(`GRANT SELECT, INSERT ON intraday.staffing_offer TO agno_intraday_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS intraday.staffing_offer;`);
  }
}
