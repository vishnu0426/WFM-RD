import * as dotenv from 'dotenv';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import vaultConfig from '../../src/vault/vault.config';
import { VaultClientService } from '../../src/vault/vault-client.service';
import { VaultSecretNotFoundError, VaultUnavailableError } from '../../src/vault/vault.errors';

dotenv.config();

/**
 * Runs against a REAL local Vault dev-mode server
 * (`vault server -dev -dev-root-token-id=<VAULT_TOKEN>`), not a mock -
 * matching this platform's "verify against the real thing" bar (the same
 * posture Module 10's RBAC work used a real ephemeral JWKS server for).
 * Requires VAULT_ADDR/VAULT_TOKEN in the environment; see
 * docs/module-12-phase-2-design-doc.md for how the dev server was started
 * for this run.
 */
describe('VaultClientService (live Vault)', () => {
  let client: VaultClientService;

  beforeAll(async () => {
    if (!process.env.VAULT_ADDR || !process.env.VAULT_TOKEN) {
      throw new Error('VAULT_ADDR/VAULT_TOKEN must be set to run this integration test against a real Vault server.');
    }
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forFeature(vaultConfig)],
      providers: [VaultClientService],
    }).compile();
    client = moduleRef.get(VaultClientService);
  });

  it('writes and reads back a secret at a fresh path', async () => {
    const path = `integration-hub-test/${Date.now()}-write-read`;
    await client.write(path, { accessToken: 'tok_live_abc123', refreshToken: 'ref_live_xyz789' });
    const secret = await client.read(path);
    expect(secret).toEqual({ accessToken: 'tok_live_abc123', refreshToken: 'ref_live_xyz789' });
    await client.delete(path);
  });

  it('overwrites an existing secret at the same path (credential rotation)', async () => {
    const path = `integration-hub-test/${Date.now()}-rotate`;
    await client.write(path, { apiKey: 'first-value' });
    await client.write(path, { apiKey: 'rotated-value' });
    const secret = await client.read(path);
    expect(secret).toEqual({ apiKey: 'rotated-value' });
    await client.delete(path);
  });

  it('fails closed with VaultSecretNotFoundError for a path that was never written', async () => {
    await expect(client.read(`integration-hub-test/${Date.now()}-never-written`)).rejects.toThrow(
      VaultSecretNotFoundError,
    );
  });

  it('fails closed with VaultSecretNotFoundError after delete, not a stale read', async () => {
    const path = `integration-hub-test/${Date.now()}-deleted`;
    await client.write(path, { secret: 'value' });
    await client.delete(path);
    await expect(client.read(path)).rejects.toThrow(VaultSecretNotFoundError);
  });

  it('§0.5 chaos test: fails closed with VaultUnavailableError when Vault is unreachable, never a cached/default value', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: false, ignoreEnvFile: true }), ConfigModule.forFeature(vaultConfig)],
      providers: [VaultClientService],
    })
      .overrideProvider(vaultConfig.KEY)
      .useValue({ addr: 'http://127.0.0.1:1', token: 'irrelevant', kvMount: 'secret' })
      .compile();
    const unreachableClient = moduleRef.get(VaultClientService);

    await expect(unreachableClient.read('integration-hub-test/unreachable')).rejects.toThrow(VaultUnavailableError);
    await expect(unreachableClient.write('integration-hub-test/unreachable', { x: 1 })).rejects.toThrow(
      VaultUnavailableError,
    );
  });
});
