import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID, createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { entities } from '../../src/database/entities';
import { IngestionCredentialsService } from '../../src/ingestion-credentials/ingestion-credentials.service';
import { VaultClientService } from '../../src/vault/vault-client.service';
import { HmacSignatureGuard } from '../../src/ingestion/hmac-signature.guard';

dotenv.config();

/**
 * The real end-to-end proof for what Phase A actually replaced: an
 * `IngestionCredentialsService` backed by real Postgres + real Vault, and
 * `HmacSignatureGuard` actually authenticating a request signed with a
 * secret that service issued - not the `INTRADAY_WEBHOOK_SECRETS` env-var
 * map any more. Same "talk to the real infra, not a mock" posture every
 * other integration spec in this directory takes.
 */
describe('IngestionCredentialsService + HmacSignatureGuard (real Postgres + real Vault)', () => {
  let appDataSource: DataSource;
  let vault: VaultClientService;
  let credentials: IngestionCredentialsService;
  const tenantId = randomUUID();

  beforeAll(async () => {
    if (!process.env.VAULT_ADDR || !process.env.VAULT_TOKEN) {
      throw new Error('VAULT_ADDR/VAULT_TOKEN must be set to run this integration test.');
    }
    appDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'agno_intraday_app',
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
    credentials = new IngestionCredentialsService(appDataSource, vault);
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
    await migrator.query(`DELETE FROM intraday.ingestion_credential WHERE tenant_id = $1`, [tenantId]);
    await migrator.destroy();
    await appDataSource.destroy();
  });

  it('issues a credential, and a request signed with its real secret authenticates through a real HmacSignatureGuard', async () => {
    const { credential, secret } = await credentials.create(tenantId, 'integration test collector');
    expect(credential.status).toBe('active');

    const config = new ConfigService({ INTRADAY_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: 300 });
    const guard = new HmacSignatureGuard(config, credentials);

    const rawBody = JSON.stringify({ sourceEventId: `evt-${randomUUID()}` });
    const timestamp = Date.now();
    const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-agno-webhook-signature': `t=${timestamp},v1=${signature}` },
          params: { tenantId },
          rawBody: Buffer.from(rawBody, 'utf8'),
        }),
      }),
    } as never;

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("rejects a request signed with a revoked credential's secret", async () => {
    const { credential, secret } = await credentials.create(tenantId, 'to be revoked');
    await credentials.revoke(tenantId, credential.id);

    const config = new ConfigService({ INTRADAY_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: 300 });
    const guard = new HmacSignatureGuard(config, credentials);

    const rawBody = '{}';
    const timestamp = Date.now();
    const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-agno-webhook-signature': `t=${timestamp},v1=${signature}` },
          params: { tenantId },
          rawBody: Buffer.from(rawBody, 'utf8'),
        }),
      }),
    } as never;

    await expect(guard.canActivate(context)).rejects.toThrow();
  });

  it('rotation: both the old and new credential authenticate until the old one is revoked', async () => {
    const oldCred = await credentials.create(tenantId, 'old');
    const newCred = await credentials.create(tenantId, 'new');

    const config = new ConfigService({ INTRADAY_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: 300 });
    const guard = new HmacSignatureGuard(config, credentials);
    const sign = (secret: string, timestamp: number, body: string) =>
      createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    const contextFor = (signature: string, timestamp: number, body: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { 'x-agno-webhook-signature': `t=${timestamp},v1=${signature}` },
            params: { tenantId },
            rawBody: Buffer.from(body, 'utf8'),
          }),
        }),
      }) as never;

    const body1 = '{"a":1}';
    const ts1 = Date.now();
    await expect(guard.canActivate(contextFor(sign(oldCred.secret, ts1, body1), ts1, body1))).resolves.toBe(true);

    const body2 = '{"a":2}';
    const ts2 = Date.now();
    await expect(guard.canActivate(contextFor(sign(newCred.secret, ts2, body2), ts2, body2))).resolves.toBe(true);

    await credentials.revoke(tenantId, oldCred.credential.id);
    const body3 = '{"a":3}';
    const ts3 = Date.now();
    await expect(guard.canActivate(contextFor(sign(oldCred.secret, ts3, body3), ts3, body3))).rejects.toThrow();
  });
});
