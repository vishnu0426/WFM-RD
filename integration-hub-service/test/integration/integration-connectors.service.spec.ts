import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { entities, IntegrationConnector } from '../../src/database/entities';
import { ConnectorStatus, ConnectorType } from '../../src/integrations/entities/integration-connector.entity';
import { VaultClientService } from '../../src/vault/vault-client.service';
import { IntegrationConnectorsService } from '../../src/connectors/integration-connectors.service';
import { OAuthTokenExchangeService } from '../../src/connectors/oauth-token-exchange.service';
import { InvalidCreateConnectorInputError } from '../../src/connectors/errors/invalid-create-connector-input.error';

dotenv.config();

/**
 * Real Postgres (RLS, ADR-0002) + real Vault (ADR-0134/0137) - both actual
 * external systems, not mocks. Requires the Phase 1 migration already
 * applied and a reachable Vault dev server; see the Phase 2 design doc for
 * how both were stood up for this run.
 */
describe('IntegrationConnectorsService (real Postgres + real Vault)', () => {
  let appDataSource: DataSource;
  let vault: VaultClientService;
  let service: IntegrationConnectorsService;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const createdConnectorIds: string[] = [];

  beforeAll(async () => {
    if (!process.env.VAULT_ADDR || !process.env.VAULT_TOKEN) {
      throw new Error('VAULT_ADDR/VAULT_TOKEN must be set to run this integration test.');
    }
    appDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'agno_integration_hub_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await appDataSource.initialize();

    vault = new VaultClientService({
      addr: process.env.VAULT_ADDR,
      token: process.env.VAULT_TOKEN,
      kvMount: process.env.VAULT_KV_MOUNT ?? 'secret',
    });
    service = new IntegrationConnectorsService(appDataSource, vault, new OAuthTokenExchangeService());
  });

  afterAll(async () => {
    const migrator = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
      password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await migrator.initialize();
    if (createdConnectorIds.length) {
      await migrator.query(`DELETE FROM integration_hub.integration_connector WHERE id = ANY($1)`, [
        createdConnectorIds,
      ]);
    }
    await migrator.destroy();
    await appDataSource.destroy();
  });

  it('rejects a create call with neither credentials nor oauth', async () => {
    await expect(service.create(tenantA, { connectorType: ConnectorType.HRIS, provider: 'Workday' })).rejects.toThrow(
      InvalidCreateConnectorInputError,
    );
  });

  it('rejects a create call with both credentials and oauth', async () => {
    await expect(
      service.create(tenantA, {
        connectorType: ConnectorType.HRIS,
        provider: 'Workday',
        credentials: { username: 'x' },
        oauth: {
          clientId: 'c',
          clientSecret: 's',
          authorizationEndpoint: 'https://example.com/authorize',
          tokenEndpoint: 'https://example.com/token',
          redirectUri: 'https://agno.example.com/oauth/callback',
        },
      }),
    ).rejects.toThrow(InvalidCreateConnectorInputError);
  });

  it('non-OAuth path: writes credentials to Vault, persists only a reference, status active immediately', async () => {
    const { connector, authorizationUrl } = await service.create(tenantA, {
      connectorType: ConnectorType.ACD,
      provider: 'Avaya Aura Contact Center',
      credentials: { cmsUsername: 'supervisor1', cmsPassword: 'super-secret-cms-password' },
    });
    createdConnectorIds.push(connector.id);

    expect(authorizationUrl).toBeNull();
    expect(connector.status).toBe(ConnectorStatus.ACTIVE);
    expect(connector.config).toHaveProperty('credentialReference');
    expect(JSON.stringify(connector.config)).not.toMatch(/super-secret-cms-password/);

    const secret = await vault.read(connector.config.credentialReference as string);
    expect(secret).toEqual({ cmsUsername: 'supervisor1', cmsPassword: 'super-secret-cms-password' });
  });

  it('OAuth path: writes the client secret to Vault, persists a pending connector + state, returns a well-formed authorization URL', async () => {
    const { connector, authorizationUrl } = await service.create(tenantA, {
      connectorType: ConnectorType.CRM,
      provider: 'Salesforce',
      oauth: {
        clientId: 'agno-wfm-salesforce-app',
        clientSecret: 'super-secret-oauth-client-secret',
        authorizationEndpoint: 'https://login.salesforce.com/services/oauth2/authorize',
        tokenEndpoint: 'https://login.salesforce.com/services/oauth2/token',
        redirectUri: 'https://agno.example.com/v1/integrations/oauth/callback',
        scope: 'api refresh_token',
      },
    });
    createdConnectorIds.push(connector.id);

    expect(connector.status).toBe(ConnectorStatus.PENDING_SETUP);
    expect(JSON.stringify(connector.config)).not.toMatch(/super-secret-oauth-client-secret/);
    expect(connector.config).toHaveProperty('oauthState');
    expect(connector.config).toHaveProperty('oauthClientSecretReference');

    const parsed = new URL(authorizationUrl!);
    expect(parsed.origin + parsed.pathname).toBe('https://login.salesforce.com/services/oauth2/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('agno-wfm-salesforce-app');
    expect(parsed.searchParams.get('state')).toBe(connector.config.oauthState);
    expect(parsed.searchParams.get('response_type')).toBe('code');

    const secret = await vault.read(connector.config.oauthClientSecretReference as string);
    expect(secret).toEqual({ clientSecret: 'super-secret-oauth-client-secret' });
  });

  it("RLS: findAllForTenant never returns another tenant's connectors", async () => {
    const { connector: connectorA } = await service.create(tenantA, {
      connectorType: ConnectorType.PAYROLL,
      provider: 'ADP',
      credentials: { apiKey: 'tenant-a-adp-key' },
    });
    const { connector: connectorB } = await service.create(tenantB, {
      connectorType: ConnectorType.PAYROLL,
      provider: 'ADP',
      credentials: { apiKey: 'tenant-b-adp-key' },
    });
    createdConnectorIds.push(connectorA.id, connectorB.id);

    const tenantAConnectors = await service.findAllForTenant(tenantA);
    const tenantBConnectors = await service.findAllForTenant(tenantB);

    expect(tenantAConnectors.map((c) => c.id)).toContain(connectorA.id);
    expect(tenantAConnectors.map((c) => c.id)).not.toContain(connectorB.id);
    expect(tenantBConnectors.map((c) => c.id)).toContain(connectorB.id);
    expect(tenantBConnectors.map((c) => c.id)).not.toContain(connectorA.id);
  });

  it('a Vault write failure (e.g. a bad path) never leaves a connector row behind', async () => {
    // Force a failure by pointing at an unreachable Vault for just this call.
    const brokenVault = new VaultClientService({ addr: 'http://127.0.0.1:1', token: 'x', kvMount: 'secret' });
    const brokenService = new IntegrationConnectorsService(appDataSource, brokenVault, new OAuthTokenExchangeService());

    await expect(
      brokenService.create(tenantA, {
        connectorType: ConnectorType.HRIS,
        provider: 'Workday-vault-failure-probe',
        credentials: { username: 'x' },
      }),
    ).rejects.toThrow();

    // Bypass RLS via the migrator role for this assertion specifically -
    // the app role's own tenant-scoped read would return 0 for the wrong
    // reason (no tenant context bound) even if the bug this test targets
    // existed, making it a false-negative test otherwise.
    const migrator = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
      password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await migrator.initialize();
    const rows = await migrator
      .getRepository(IntegrationConnector)
      .count({ where: { provider: 'Workday-vault-failure-probe' } });
    await migrator.destroy();
    expect(rows).toBe(0);
  });
});
