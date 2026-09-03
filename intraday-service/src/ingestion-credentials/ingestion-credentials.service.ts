import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { VaultClientService } from '../vault/vault-client.service';
import { IngestionCredentialNotFoundError } from '../common/errors/ingestion-credential-not-found.error';
import { IngestionCredential } from './entities/ingestion-credential.entity';

export interface CreateIngestionCredentialResult {
  credential: IngestionCredential;
  /** The raw HMAC secret - returned exactly once, from this call only. Every subsequent read goes through Vault via `secretReference`, never this table - same discipline `integration-hub-service`'s `WebhookSubscriptionsService.create` already established for the identical shape of problem. */
  secret: string;
}

/**
 * CRUD for `IngestionCredential` - what `HmacSignatureGuard` replaced its
 * `INTRADAY_WEBHOOK_SECRETS` env-var lookup with. `create`/`revoke` are
 * self-service, admin-facing actions (`IngestionCredentialsController`);
 * `listActiveSecrets` is the guard's own read path, on the hot request
 * path for every inbound ACD/on-prem-collector event.
 */
@Injectable()
export class IngestionCredentialsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly vault: VaultClientService,
  ) {}

  async create(tenantId: string, label?: string): Promise<CreateIngestionCredentialResult> {
    const id = randomUUID();
    const secret = randomBytes(24).toString('base64url');
    const secretReference = this.secretVaultPath(tenantId, id);
    await this.vault.write(secretReference, { secret });

    const credential = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.save(IngestionCredential, {
        id,
        tenantId,
        secretReference,
        label: label ?? null,
        status: 'active',
        createdAt: new Date(),
        revokedAt: null,
      }),
    );

    return { credential, secret };
  }

  async listAllForTenant(tenantId: string): Promise<IngestionCredential[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(IngestionCredential).find({ where: { tenantId }, order: { createdAt: 'DESC' } }),
    );
  }

  async revoke(tenantId: string, id: string): Promise<IngestionCredential> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const repository = manager.getRepository(IngestionCredential);
      const credential = await repository.findOne({ where: { tenantId, id } });
      if (!credential) {
        throw new IngestionCredentialNotFoundError(id);
      }
      if (credential.status === 'active') {
        credential.status = 'revoked';
        credential.revokedAt = new Date();
        await repository.save(credential);
      }
      return credential;
    });
  }

  /**
   * `HmacSignatureGuard`'s own read path - every active credential's raw
   * secret for this tenant, read fresh from Vault on every call (never
   * cached), same "don't hold secret material longer than the one call
   * that needs it" posture `WebhookDeliveryDispatcherService` already
   * accepts for its own hot-ish path. A tenant mid-rotation has two active
   * rows; this returns both, and the guard tries each until one matches.
   */
  async listActiveSecrets(tenantId: string): Promise<string[]> {
    const active = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(IngestionCredential).find({ where: { tenantId, status: 'active' } }),
    );
    const secrets: string[] = [];
    for (const credential of active) {
      try {
        const value = await this.vault.read(credential.secretReference);
        if (typeof value.secret === 'string') {
          secrets.push(value.secret);
        }
      } catch {
        // A credential row whose Vault secret is unreadable (deleted out
        // of band, Vault outage) simply can't authenticate a request -
        // skip it rather than failing the whole lookup for every other
        // still-good credential this tenant holds.
      }
    }
    return secrets;
  }

  private secretVaultPath(tenantId: string, credentialId: string): string {
    return `intraday/${tenantId}/ingestion-credential/${credentialId}/secret`;
  }
}
