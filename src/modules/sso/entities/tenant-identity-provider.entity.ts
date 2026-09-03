import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { IdentityProviderProtocol } from './identity-provider-protocol.enum';
import { OAuthInvalidRequestError } from '../../auth/errors/invalid-request.error';

export interface AttributeMapping {
  email?: string;
  givenName?: string;
  familyName?: string;
  groups?: string;
}

/**
 * §5.5: per-tenant IdP federation config. ADR-0029 (reuses ADR-0028's
 * shape): SELECT is open across tenants because `SsoController`'s callback
 * resolves *which* provider a SAMLResponse/OIDC redirect belongs to via this
 * row's `id` (carried through RelayState/`state`) before any tenant context
 * exists to scope the lookup by.
 *
 * `oidcClientSecret`/`samlCertificate` in plaintext columns is the same
 * explicit Phase-2-precedent trade-off as `SigningKey.privateKeyPem`
 * (ADR-0024) - flagged in the production readiness checklist, not silently
 * implied production-ready.
 */
@Entity({ schema: 'core', name: 'tenant_identity_providers' })
@Index('idx_tenant_idp_tenant_id', ['tenantId'])
export class TenantIdentityProvider {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 10 })
  protocol!: IdentityProviderProtocol;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  @Column({ type: 'text', name: 'oidc_discovery_url', nullable: true })
  oidcDiscoveryUrl!: string | null;

  @Column({ type: 'varchar', length: 255, name: 'oidc_client_id', nullable: true })
  oidcClientId!: string | null;

  @Column({ type: 'text', name: 'oidc_client_secret', nullable: true })
  oidcClientSecret!: string | null;

  @Column({ type: 'text', name: 'saml_entity_id', nullable: true })
  samlEntityId!: string | null;

  @Column({ type: 'text', name: 'saml_sso_url', nullable: true })
  samlSsoUrl!: string | null;

  @Column({ type: 'text', name: 'saml_slo_url', nullable: true })
  samlSloUrl!: string | null;

  @Column({ type: 'text', name: 'saml_certificate', nullable: true })
  samlCertificate!: string | null;

  @Column({ type: 'jsonb', name: 'attribute_mapping', default: '{}' })
  attributeMapping!: AttributeMapping;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @BeforeInsert()
  @BeforeUpdate()
  validateProtocolFields(): void {
    // Mirrors the DB CHECK constraints client-side (same posture as
    // OAuthClient.validateSecretMatchesType) so a bad row fails with a
    // DomainError at the service boundary, not a raw Postgres error string.
    if (this.protocol === IdentityProviderProtocol.OIDC) {
      if (!this.oidcDiscoveryUrl || !this.oidcClientId || !this.oidcClientSecret) {
        throw new OAuthInvalidRequestError(
          'OIDC identity providers require oidcDiscoveryUrl, oidcClientId, and oidcClientSecret.',
        );
      }
    } else if (this.protocol === IdentityProviderProtocol.SAML) {
      if (!this.samlEntityId || !this.samlSsoUrl || !this.samlCertificate) {
        throw new OAuthInvalidRequestError(
          'SAML identity providers require samlEntityId, samlSsoUrl, and samlCertificate.',
        );
      }
    }
  }
}
