import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Frontend Phase 8 (§4/§0 gap): closes two real gaps found while building
 * `/admin/users` - `inviteUser` had no backend support at all (no user
 * creation flow, no notification-delivery mechanism reachable pre-auth),
 * and `revokeUserSession` had no admin-facing endpoint even though
 * `RefreshTokenService.revokeAllSessionsForUser` already existed (used
 * only internally by SCIM deprovisioning until now).
 *
 * `user_invites` mirrors `tenant_identity_providers`' own read-open/
 * write-gated RLS shape (ADR-0029): `SELECT` must be open because
 * `POST /v1/auth/accept-invite` looks a row up by its token hash *before*
 * any tenant context can be bound - the invited user has no session yet.
 * Every write stays tenant-gated. `token_hash` (SHA-256, same convention
 * `RefreshToken.tokenHash` already uses) is the only representation of the
 * invite token ever persisted - the raw token exists only in memory for the
 * duration of the invite request and whatever the (placeholder, logging-only)
 * notification channel logs it to, same "never store the raw secret"
 * posture the platform already applies everywhere else a bearer credential
 * exists.
 */
export class UserInvitesAndSessionRevocation1700000019000 implements MigrationInterface {
  name = 'UserInvitesAndSessionRevocation1700000019000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    await queryRunner.query(`
      CREATE TABLE core.user_invites (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL REFERENCES core.tenants(id),
        user_id       uuid NOT NULL,
        token_hash    varchar(64) NOT NULL,
        invited_email varchar(320) NOT NULL,
        expires_at    timestamptz NOT NULL,
        accepted_at   timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_user_invites_token_hash UNIQUE (token_hash),
        CONSTRAINT fk_user_invites_tenant_user FOREIGN KEY (tenant_id, user_id)
          REFERENCES core.users(tenant_id, id) ON DELETE CASCADE
      );
    `);
    await queryRunner.query(`CREATE INDEX idx_user_invites_tenant_id ON core.user_invites (tenant_id);`);

    await queryRunner.query(`ALTER TABLE core.user_invites ENABLE ROW LEVEL SECURITY;`);
    // token-hash lookup happens before any tenant context is bound - same
    // structural reason ADR-0029 made tenant_identity_providers' SELECT open.
    await queryRunner.query(`CREATE POLICY user_invites_select ON core.user_invites FOR SELECT USING (true);`);
    await queryRunner.query(`
      CREATE POLICY user_invites_insert ON core.user_invites FOR INSERT WITH CHECK (tenant_id = ${tenantIdExpr});
    `);
    await queryRunner.query(`
      CREATE POLICY user_invites_update ON core.user_invites FOR UPDATE
      USING (tenant_id = ${tenantIdExpr}) WITH CHECK (tenant_id = ${tenantIdExpr});
    `);

    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON core.user_invites TO agno_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.user_invites;`);
  }
}
