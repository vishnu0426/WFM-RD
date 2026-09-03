import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantMismatchError } from '../../../common/tenant/tenant-context.errors';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { OAuthClient } from '../entities/oauth-client.entity';
import { InvalidClientError } from '../errors/invalid-client.error';

type CreateOAuthClientInput = Omit<OAuthClient, 'id' | 'createdAt' | 'updatedAt' | 'validateSecretMatchesType'>;

/**
 * Deliberately not a `TenantScopedRepository` subclass (ADR-0028):
 * `findByClientId` is the lookup used at `POST /oauth/token` and
 * `POST /oauth/authorize` *before* any tenant context can be bound - the
 * client_id is how the tenant gets resolved in the first place. It relies on
 * the `oauth_clients_select` RLS policy being open (`USING (true)`), not on a
 * bound session variable. Every write path, by contrast, requires a bound
 * tenant context and goes through `withTenantTransaction` exactly like
 * `TenantScopedRepository` would, so writes stay tenant-gated
 * (`oauth_clients_insert`/`_update` RLS policies).
 */
@Injectable()
export class OAuthClientsRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Open, cross-tenant lookup by the public client_id - see class doc comment. */
  async findByClientId(clientId: string): Promise<OAuthClient | null> {
    return this.dataSource.getRepository(OAuthClient).findOne({ where: { clientId } });
  }

  async findByTenantAndId(id: string): Promise<OAuthClient | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager.getRepository(OAuthClient).findOne({ where: { id, tenantId } }),
    );
  }

  async findAllForTenant(): Promise<OAuthClient[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager.getRepository(OAuthClient).find({ where: { tenantId }, order: { createdAt: 'DESC' } }),
    );
  }

  async create(input: CreateOAuthClientInput): Promise<OAuthClient> {
    const tenantId = this.tenantContext.requireTenantId();
    if (input.tenantId !== tenantId) {
      throw new TenantMismatchError(tenantId, input.tenantId);
    }
    return withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager.getRepository(OAuthClient).save(manager.getRepository(OAuthClient).create(input)),
    );
  }

  /** Soft-disable, not a hard delete - mirrors `isActive` being the only lifecycle column this entity has. */
  async deactivate(id: string): Promise<OAuthClient> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, async (manager) => {
      const repo = manager.getRepository(OAuthClient);
      const client = await repo.findOne({ where: { id, tenantId } });
      if (!client) {
        throw new InvalidClientError('OAuth client not found for this tenant.');
      }
      client.isActive = false;
      return repo.save(client);
    });
  }
}
