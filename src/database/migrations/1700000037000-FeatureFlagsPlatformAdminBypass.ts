import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Platform Admin's cross-tenant Feature Flags view (Tenant Monitoring
 * console): `org.feature_flags`'s RLS policy had no `platform_admin`
 * escape clause (unlike its sibling `outbox_events`, added in the same
 * original migration - `1700000003000-Module02EventingAndBulkImport.ts`
 * - for the outbox publisher's own cross-tenant polling). Same clause
 * shape, added here rather than there since this need didn't exist until
 * now.
 */
export class FeatureFlagsPlatformAdminBypass1700000037000 implements MigrationInterface {
  name = 'FeatureFlagsPlatformAdminBypass1700000037000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;
    const platformAdminExpr = `current_setting('app.is_platform_admin', true) = 'true'`;

    await queryRunner.query(`DROP POLICY tenant_isolation ON org.feature_flags;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON org.feature_flags FOR ALL
      USING (${platformAdminExpr} OR tenant_id = ${tenantIdExpr})
      WITH CHECK (${platformAdminExpr} OR tenant_id = ${tenantIdExpr});
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;
    await queryRunner.query(`DROP POLICY tenant_isolation ON org.feature_flags;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON org.feature_flags FOR ALL
      USING (tenant_id = ${tenantIdExpr})
      WITH CHECK (tenant_id = ${tenantIdExpr});
    `);
  }
}
