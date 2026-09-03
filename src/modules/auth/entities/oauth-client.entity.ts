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
import { OAuthClientType } from './oauth-client-type.enum';
import { OAuthGrantType } from './oauth-grant-type.enum';
import { TokenEndpointAuthMethod } from './token-endpoint-auth-method.enum';
import { InvalidClientError } from '../errors/invalid-client.error';

/**
 * ADR-0028: read-open / write-tenant-gated RLS - `client_id` is the lookup
 * key at `POST /oauth/token` *before* any tenant context exists, so this
 * table cannot use the closed `tenant_isolation` policy every other table in
 * this module uses. `client_secret_hash` is null for public (PKCE) clients
 * per the `oauth_clients_secret_matches_type` CHECK constraint.
 */
@Entity({ schema: 'core', name: 'oauth_clients' })
@Index('idx_oauth_clients_tenant_id', ['tenantId'])
export class OAuthClient {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 100, name: 'client_id' })
  clientId!: string;

  @Column({ type: 'varchar', length: 255, name: 'client_secret_hash', nullable: true })
  clientSecretHash!: string | null;

  @Column({ type: 'varchar', length: 20, name: 'client_type' })
  clientType!: OAuthClientType;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', array: true, name: 'allowed_grant_types' })
  allowedGrantTypes!: OAuthGrantType[];

  @Column({ type: 'text', array: true, name: 'redirect_uris', default: '{}' })
  redirectUris!: string[];

  @Column({ type: 'varchar', length: 30, name: 'token_endpoint_auth_method' })
  tokenEndpointAuthMethod!: TokenEndpointAuthMethod;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @BeforeInsert()
  @BeforeUpdate()
  validateSecretMatchesType(): void {
    // Mirrors the DB CHECK constraint client-side so a bad row fails at the
    // service boundary with a DomainError, not a raw Postgres error string.
    const hasSecret = this.clientSecretHash !== null && this.clientSecretHash !== undefined;
    if (this.clientType === OAuthClientType.PUBLIC && hasSecret) {
      throw new InvalidClientError('Public clients must not have a client secret.');
    }
    if (this.clientType === OAuthClientType.CONFIDENTIAL && !hasSecret) {
      throw new InvalidClientError('Confidential clients must have a client secret.');
    }
  }
}
