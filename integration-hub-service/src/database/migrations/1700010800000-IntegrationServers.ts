import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Integration Servers - previously marked UNSUPPORTED ("no on-prem
 * managed-server registry concept exists in this SaaS architecture").
 * Built for real on explicit request, with one deliberate framing that
 * must not get lost: this is a real, persisted **inventory/registry** of
 * a tenant's own on-prem recording infrastructure (grounded in real,
 * researched field names/roles from Verint WFO/EMT's actual "Server"/
 * "Recorder Integration Service" admin screens - see IntegrationServer
 * entity's own doc comment for sources) - it is NOT a control plane. This
 * platform has no on-prem agent/process anywhere that reads a
 * `roles`/`portNumber`/etc. value and does something with it (no RMI
 * connection, no TDM/SIP signaling termination) - there is genuinely
 * nothing here for it to control. What's real is that a tenant admin can
 * now document their own deployment topology (which physical/virtual
 * servers exist, what roles each runs, how they're networked) as a real
 * system of record, with real persistence/RBAC/audit - not a fabricated
 * capability, but also not the same thing as the live per-connector
 * integrations (Data Sources) this platform actually operates.
 */
export class IntegrationServers1700010800000 implements MigrationInterface {
  name = 'IntegrationServers1700010800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    await queryRunner.query(`
      CREATE TABLE integration_hub.integration_server (
        id                  uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        name                varchar(200) NOT NULL,
        description         varchar(2000),
        server_name         varchar(255) NOT NULL,
        port_number         integer,
        https_port_number   integer,
        http_alias          varchar(255),
        blocked             boolean NOT NULL DEFAULT false,
        roles               varchar(50)[] NOT NULL DEFAULT '{}',
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, name),
        CONSTRAINT integration_server_port_check
          CHECK (port_number IS NULL OR (port_number BETWEEN 1 AND 65535)),
        CONSTRAINT integration_server_https_port_check
          CHECK (https_port_number IS NULL OR (https_port_number BETWEEN 1 AND 65535)),
        CONSTRAINT integration_server_roles_check
          CHECK (roles <@ ARRAY[
            'recorder_integration_service', 'ip_recorder', 'tdm_recorder', 'screen_recorder',
            'recorder_adapter_proxy_service', 'content_server', 'ip_analyzer', 'central_archive'
          ]::varchar[])
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_integration_server_tenant ON integration_hub.integration_server (tenant_id);
    `);

    // "Associated Integration Service Installations" - which registered
    // servers a given data source (connector) is documented against.
    // Many-to-many: a server can host roles shared across multiple data
    // sources (e.g. one Recorder Integration Service server serving
    // several phone data sources), matching the real product's own model.
    await queryRunner.query(`
      CREATE TABLE integration_hub.integration_connector_server (
        id             uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        connector_id   uuid NOT NULL,
        server_id      uuid NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (connector_id, server_id),
        CONSTRAINT integration_connector_server_connector_fk
          FOREIGN KEY (tenant_id, connector_id)
          REFERENCES integration_hub.integration_connector (tenant_id, id),
        CONSTRAINT integration_connector_server_server_fk
          FOREIGN KEY (tenant_id, server_id)
          REFERENCES integration_hub.integration_server (tenant_id, id)
          ON DELETE CASCADE
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_integration_connector_server_tenant_connector
      ON integration_hub.integration_connector_server (tenant_id, connector_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_integration_connector_server_tenant_server
      ON integration_hub.integration_connector_server (tenant_id, server_id);
    `);

    const tenantScopedTables = ['integration_server', 'integration_connector_server'];
    for (const table of tenantScopedTables) {
      await queryRunner.query(`ALTER TABLE integration_hub.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON integration_hub.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
    }

    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON integration_hub.integration_server TO agno_integration_hub_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON integration_hub.integration_connector_server TO agno_integration_hub_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS integration_hub.integration_connector_server;`);
    await queryRunner.query(`DROP TABLE IF EXISTS integration_hub.integration_server;`);
  }
}
