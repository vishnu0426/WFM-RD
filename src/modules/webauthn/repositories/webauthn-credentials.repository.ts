import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { WebAuthnCredential } from '../entities/webauthn-credential.entity';

@Injectable()
export class WebAuthnCredentialsRepository extends TenantScopedRepository<WebAuthnCredential> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, WebAuthnCredential, tenantContext);
  }

  async findForUser(userId: string): Promise<WebAuthnCredential[]> {
    return this.find({ where: { userId } as never });
  }

  /**
   * Lookup by the WebAuthn `credentialId` (base64url) an authenticator
   * reports on assertion - globally unique (`uq_webauthn_credentials_credential_id`),
   * but still queried within the tenant already resolved from the request's
   * `client_id` (mirrors `PasswordAuthService`'s posture: this never runs
   * before a tenant context is bound).
   */
  async findByCredentialId(credentialId: string): Promise<WebAuthnCredential | null> {
    return this.findOne({ where: { credentialId } as never });
  }

  async updateCounter(id: string, counter: number): Promise<void> {
    await this.update({ id } as never, { counter, lastUsedAt: new Date() } as never);
  }
}
