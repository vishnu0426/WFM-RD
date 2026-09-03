import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantMismatchError } from '../../../common/tenant/tenant-context.errors';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { TenantIdentityProvider } from '../entities/tenant-identity-provider.entity';

type CreateInput = Omit<TenantIdentityProvider, 'id' | 'createdAt' | 'updatedAt' | 'validateProtocolFields'>;
type UpdateInput = Partial<CreateInput>;

/**
 * Deliberately not a `TenantScopedRepository` subclass (ADR-0029, mirroring
 * ADR-0028): `findById` is the lookup `SsoController`'s callback uses to
 * resolve which provider a SAMLResponse/OIDC redirect belongs to, *before*
 * any tenant context can be bound - it relies on the `tenant_idp_select` RLS
 * policy being open (`USING (true)`). Every write path requires a bound
 * tenant context and stays tenant-gated via `withTenantTransaction`.
 */
@Injectable()
export class TenantIdentityProvidersRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Open, cross-tenant lookup by id - see class doc comment. */
  async findById(id: string): Promise<TenantIdentityProvider | null> {
    return this.dataSource.getRepository(TenantIdentityProvider).findOne({ where: { id } });
  }

  async findByTenantAndId(id: string): Promise<TenantIdentityProvider | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager.getRepository(TenantIdentityProvider).findOne({ where: { id, tenantId } }),
    );
  }

  async findAllForTenant(): Promise<TenantIdentityProvider[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager.getRepository(TenantIdentityProvider).find({ where: { tenantId }, order: { createdAt: 'DESC' } }),
    );
  }

  async create(input: CreateInput): Promise<TenantIdentityProvider> {
    const tenantId = this.tenantContext.requireTenantId();
    if (input.tenantId !== tenantId) {
      throw new TenantMismatchError(tenantId, input.tenantId);
    }
    return withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager.getRepository(TenantIdentityProvider).save(manager.getRepository(TenantIdentityProvider).create(input)),
    );
  }

  async update(id: string, input: UpdateInput): Promise<TenantIdentityProvider | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, async (manager) => {
      const repo = manager.getRepository(TenantIdentityProvider);
      const existing = await repo.findOne({ where: { id, tenantId } });
      if (!existing) {
        return null;
      }
      repo.merge(existing, input);
      return repo.save(existing);
    });
  }

  async delete(id: string): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    await withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager.getRepository(TenantIdentityProvider).delete({ id, tenantId }),
    );
  }
}
