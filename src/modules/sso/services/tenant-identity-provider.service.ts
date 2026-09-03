import { Injectable } from '@nestjs/common';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantIdentityProvidersRepository } from '../repositories/tenant-identity-providers.repository';
import { TenantIdentityProvider } from '../entities/tenant-identity-provider.entity';
import { CreateIdentityProviderDto } from '../dto/create-identity-provider.dto';
import { UpdateIdentityProviderDto } from '../dto/update-identity-provider.dto';
import { IdentityProviderNotFoundError } from '../errors/identity-provider-not-found.error';

/** Admin CRUD over §5.5's per-tenant IdP config. Field-level validation lives on the entity (see its doc comment). */
@Injectable()
export class TenantIdentityProviderService {
  constructor(
    private readonly repository: TenantIdentityProvidersRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(): Promise<TenantIdentityProvider[]> {
    return this.repository.findAllForTenant();
  }

  async getOrFail(id: string): Promise<TenantIdentityProvider> {
    const provider = await this.repository.findByTenantAndId(id);
    if (!provider) {
      throw new IdentityProviderNotFoundError(id);
    }
    return provider;
  }

  async create(input: CreateIdentityProviderDto): Promise<TenantIdentityProvider> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.repository.create({
      tenantId,
      protocol: input.protocol,
      name: input.name,
      isActive: input.isActive ?? true,
      oidcDiscoveryUrl: input.oidcDiscoveryUrl ?? null,
      oidcClientId: input.oidcClientId ?? null,
      oidcClientSecret: input.oidcClientSecret ?? null,
      samlEntityId: input.samlEntityId ?? null,
      samlSsoUrl: input.samlSsoUrl ?? null,
      samlSloUrl: input.samlSloUrl ?? null,
      samlCertificate: input.samlCertificate ?? null,
      attributeMapping: input.attributeMapping ?? {},
    });
  }

  async update(id: string, input: UpdateIdentityProviderDto): Promise<TenantIdentityProvider> {
    const updated = await this.repository.update(id, input);
    if (!updated) {
      throw new IdentityProviderNotFoundError(id);
    }
    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.getOrFail(id);
    await this.repository.delete(id);
  }
}
