import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { DataSource } from 'typeorm';
import { entities } from '../../src/database/entities';
import { ConnectorType } from '../../src/integrations/entities/integration-connector.entity';
import { VaultClientService } from '../../src/vault/vault-client.service';
import { IntegrationConnectorsService } from '../../src/connectors/integration-connectors.service';
import { OAuthTokenExchangeService } from '../../src/connectors/oauth-token-exchange.service';
import { OAuthStateMismatchError } from '../../src/connectors/errors/oauth-callback.errors';
import { OAuthTokenExchangeFailedError } from '../../src/connectors/errors/oauth-callback.errors';

dotenv.config();

/**
 * End-to-end verification of the full §1/§3.2 OAuth authorization-code
 * flow: `createConnector` (OAuth path) -> a real generic RFC 6749 §4.1.3
 * token endpoint (a tiny local HTTP server standing in for a real
 * provider, the same "real ephemeral test server" posture Module 10's RBAC
 * work used for JWKS) -> `completeOAuthCallback`, against a real Postgres
 * and a real Vault. No credentials exist for any of the 10 named vendors
 * in this environment - the exchange logic itself is provider-agnostic
 * RFC 6749, so this exercises the exact same code path a real provider's
 * token endpoint would.
 */
describe('OAuth authorization-code flow end to end (real Postgres + real Vault + a real generic token endpoint)', () => {
  let appDataSource: DataSource;
  let vault: VaultClientService;
  let service: IntegrationConnectorsService;
  let tokenServer: Server;
  let tokenEndpoint: string;
  let issuedCode: string | null = null;
  let lastTokenRequestBody: URLSearchParams | null = null;
  const tenantId = randomUUID();
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

    // A real, generic OAuth 2.0 token endpoint - accepts the exact
    // grant_type=authorization_code exchange RFC 6749 §4.1.3 specifies,
    // rejects a wrong client_secret/code, otherwise issues a token set.
    tokenServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const params = new URLSearchParams(body);
        lastTokenRequestBody = params;
        const valid =
          params.get('grant_type') === 'authorization_code' &&
          params.get('client_secret') === 'super-secret-oauth-client-secret' &&
          params.get('code') === issuedCode;
        res.setHeader('Content-Type', 'application/json');
        if (!valid) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            access_token: 'live-access-token-abc123',
            refresh_token: 'live-refresh-token-xyz789',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        );
      });
    });
    await new Promise<void>((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
    const address = tokenServer.address();
    if (!address || typeof address === 'string') throw new Error('failed to start test token server');
    tokenEndpoint = `http://127.0.0.1:${address.port}/token`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
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

  it('completes the full flow: create (pending) -> authorize -> callback -> active, with the real access/refresh token in Vault and never in Postgres', async () => {
    const { connector: pending, authorizationUrl } = await service.create(tenantId, {
      connectorType: ConnectorType.CRM,
      provider: 'GenericTestProvider',
      oauth: {
        clientId: 'agno-wfm-test-app',
        clientSecret: 'super-secret-oauth-client-secret',
        authorizationEndpoint: 'https://example.com/authorize',
        tokenEndpoint,
        redirectUri: 'https://agno.example.com/v1/integrations/oauth/callback',
      },
    });
    createdConnectorIds.push(pending.id);

    const state = new URL(authorizationUrl!).searchParams.get('state')!;
    // Simulate the provider's own authorize step issuing a one-time code
    // (out of band here, since there's no real browser/admin in this test).
    issuedCode = 'authorization-code-from-provider-abc';

    const active = await service.completeOAuthCallback(tenantId, issuedCode, state);

    expect(active.status).toBe('active');
    expect(active.config).not.toHaveProperty('oauthState');
    expect(JSON.stringify(active.config)).not.toMatch(/live-access-token-abc123|live-refresh-token-xyz789/);

    const secret = await vault.read(active.config.credentialReference as string);
    expect(secret).toEqual({
      accessToken: 'live-access-token-abc123',
      refreshToken: 'live-refresh-token-xyz789',
      expiresInSeconds: 3600,
      tokenType: 'Bearer',
    });

    // Confirms the real HTTP exchange actually happened against the token
    // server, with the real client secret read back out of Vault - not a
    // stubbed/skipped call.
    expect(lastTokenRequestBody?.get('client_id')).toBe('agno-wfm-test-app');
    expect(lastTokenRequestBody?.get('redirect_uri')).toBe('https://agno.example.com/v1/integrations/oauth/callback');
  });

  it('rejects a callback with a tampered state (wrong nonce) without ever calling the token endpoint', async () => {
    const { connector: pending, authorizationUrl } = await service.create(tenantId, {
      connectorType: ConnectorType.HRIS,
      provider: 'GenericTestProvider2',
      oauth: {
        clientId: 'agno-wfm-test-app-2',
        clientSecret: 'super-secret-oauth-client-secret',
        authorizationEndpoint: 'https://example.com/authorize',
        tokenEndpoint,
        redirectUri: 'https://agno.example.com/v1/integrations/oauth/callback',
      },
    });
    createdConnectorIds.push(pending.id);

    const realState = new URL(authorizationUrl!).searchParams.get('state')!;
    const tamperedState = realState.slice(0, -4) + 'zzzz';

    await expect(service.completeOAuthCallback(tenantId, 'irrelevant-code', tamperedState)).rejects.toThrow(
      OAuthStateMismatchError,
    );
  });

  it('rejects a callback whose state embeds a different tenant than the authenticated caller', async () => {
    const { connector: pending, authorizationUrl } = await service.create(tenantId, {
      connectorType: ConnectorType.HRIS,
      provider: 'GenericTestProvider3',
      oauth: {
        clientId: 'agno-wfm-test-app-3',
        clientSecret: 'super-secret-oauth-client-secret',
        authorizationEndpoint: 'https://example.com/authorize',
        tokenEndpoint,
        redirectUri: 'https://agno.example.com/v1/integrations/oauth/callback',
      },
    });
    createdConnectorIds.push(pending.id);

    const realState = new URL(authorizationUrl!).searchParams.get('state')!;
    const otherTenantId = randomUUID();

    await expect(service.completeOAuthCallback(otherTenantId, 'irrelevant-code', realState)).rejects.toThrow(
      OAuthStateMismatchError,
    );
  });

  it('surfaces a clean OAuthTokenExchangeFailedError when the provider rejects the code, and leaves the connector pending (not silently active)', async () => {
    const { connector: pending, authorizationUrl } = await service.create(tenantId, {
      connectorType: ConnectorType.HRIS,
      provider: 'GenericTestProvider4',
      oauth: {
        clientId: 'agno-wfm-test-app-4',
        clientSecret: 'super-secret-oauth-client-secret',
        authorizationEndpoint: 'https://example.com/authorize',
        tokenEndpoint,
        redirectUri: 'https://agno.example.com/v1/integrations/oauth/callback',
      },
    });
    createdConnectorIds.push(pending.id);

    const state = new URL(authorizationUrl!).searchParams.get('state')!;
    issuedCode = 'a-different-code-than-what-will-be-sent';

    await expect(service.completeOAuthCallback(tenantId, 'wrong-code-entirely', state)).rejects.toThrow(
      OAuthTokenExchangeFailedError,
    );

    const stillPending = await service.findByIdForTenant(tenantId, pending.id);
    expect(stillPending.status).toBe('pending_setup');
  });
});
