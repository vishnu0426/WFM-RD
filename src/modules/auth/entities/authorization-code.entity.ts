import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * ADR-0027: `codeChallengeMethod` is always `S256` - OAuth2.1 forbids the
 * `plain` PKCE method entirely, enforced both here (DB CHECK) and in
 * `PkceService` (rejects any other value before a row is ever built). Only
 * `codeHash` (SHA-256 of the code) is persisted; the code itself exists only
 * in the redirect URL handed to the client.
 */
@Entity({ schema: 'core', name: 'authorization_codes' })
@Index('idx_authorization_codes_tenant_id_expires_at', ['tenantId', 'expiresAt'])
@Index('idx_authorization_codes_tenant_id_client_id', ['tenantId', 'clientId'])
export class AuthorizationCode {
  @PrimaryColumn({ type: 'varchar', length: 128, name: 'code_hash' })
  codeHash!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'client_id' })
  clientId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'text', name: 'redirect_uri' })
  redirectUri!: string;

  @Column({ type: 'varchar', length: 128, name: 'code_challenge' })
  codeChallenge!: string;

  @Column({ type: 'varchar', length: 10, name: 'code_challenge_method', default: 'S256' })
  codeChallengeMethod!: 'S256';

  @Column({ type: 'text', default: '' })
  scope!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  nonce!: string | null;

  @Column({ type: 'timestamptz', name: 'auth_time' })
  authTime!: Date;

  @Column({ type: 'text', array: true, default: '{}' })
  amr!: string[];

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', name: 'consumed_at', nullable: true })
  consumedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
