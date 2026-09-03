import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * User Management audit GAP-03: the reference Interactions screen's
 * "Recording properties" / "System Defined" / "Inbox" / "Conditional custom
 * data" / "Inherit settings from current organization" fields had no
 * backend of any kind — not even a place to persist a configured value,
 * let alone a telephony integration that would act on it. This adds a real,
 * persisted per-org-unit settings row (one per org unit that has ever been
 * configured — inheriting units simply have no row) so the *configuration
 * surface* is genuine: create/read/update it, and resolve an effective
 * value by walking up `org.org_units.parent_org_unit_id` while
 * `inherit_from_parent` is true. No telephony/recording engine consumes
 * these percentages yet — that integration doesn't exist in this platform,
 * same disclosed boundary the frontend's own copy already states — but the
 * data model and its persistence are real, not simulated.
 */
export class OrgUnitInteractionSettings1700000034000 implements MigrationInterface {
  name = 'OrgUnitInteractionSettings1700000034000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;
    const platformAdminExpr = `current_setting('app.is_platform_admin', true) = 'true'`;

    await queryRunner.query(`
      CREATE TABLE org.org_unit_interaction_settings (
        tenant_id                      uuid NOT NULL,
        org_unit_id                    uuid NOT NULL,
        inherit_from_parent            boolean NOT NULL DEFAULT true,
        system_defined                 boolean NOT NULL DEFAULT true,
        audio_recording_percentage     numeric(5,2),
        video_recording_percentage     numeric(5,2),
        screen_recording_percentage    numeric(5,2),
        inbox_url                      text,
        conditional_custom_data        jsonb,
        updated_at                     timestamptz NOT NULL DEFAULT now(),
        updated_by                     uuid,
        PRIMARY KEY (tenant_id, org_unit_id),
        CONSTRAINT org_unit_interaction_settings_org_unit_fkey
          FOREIGN KEY (org_unit_id) REFERENCES org.org_units (id) ON DELETE CASCADE,
        CONSTRAINT org_unit_interaction_settings_audio_pct_check CHECK (audio_recording_percentage IS NULL OR (audio_recording_percentage BETWEEN 0 AND 100)),
        CONSTRAINT org_unit_interaction_settings_video_pct_check CHECK (video_recording_percentage IS NULL OR (video_recording_percentage BETWEEN 0 AND 100)),
        CONSTRAINT org_unit_interaction_settings_screen_pct_check CHECK (screen_recording_percentage IS NULL OR (screen_recording_percentage BETWEEN 0 AND 100))
      );

      ALTER TABLE org.org_unit_interaction_settings ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON org.org_unit_interaction_settings FOR ALL
      USING (${platformAdminExpr} OR tenant_id = ${tenantIdExpr})
      WITH CHECK (${platformAdminExpr} OR tenant_id = ${tenantIdExpr});

      GRANT SELECT, INSERT, UPDATE, DELETE ON org.org_unit_interaction_settings TO agno_app;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE org.org_unit_interaction_settings;`);
  }
}
