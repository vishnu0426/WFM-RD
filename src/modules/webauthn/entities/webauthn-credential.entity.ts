import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { WebAuthnDeviceType } from './webauthn-device-type.enum';

/**
 * §5.4: WebAuthn/Passkeys as a first-class MFA/primary-auth option. `counter`
 * is the signature counter authenticators report on each assertion -
 * `WebAuthnService` rejects an assertion whose counter doesn't strictly
 * increase (a standard clone-detection signal: a cloned authenticator's
 * counter falls behind or repeats).
 */
@Entity({ schema: 'core', name: 'webauthn_credentials' })
@Index('idx_webauthn_credentials_tenant_id_user_id', ['tenantId', 'userId'])
export class WebAuthnCredential {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', length: 512, name: 'credential_id' })
  credentialId!: string;

  @Column({ type: 'text', name: 'public_key' })
  publicKey!: string;

  // WebAuthn's counter is spec'd as unsigned 32-bit; `integer` (Postgres
  // int4, +/-2^31) comfortably covers every realistic authenticator's
  // lifetime signature count without needing bigint's string-mapping
  // TypeORM default.
  @Column({ type: 'integer' })
  counter!: number;

  @Column({ type: 'varchar', length: 20, name: 'device_type' })
  deviceType!: WebAuthnDeviceType;

  @Column({ type: 'boolean', name: 'backed_up', default: false })
  backedUp!: boolean;

  @Column({ type: 'text', array: true, default: '{}' })
  transports!: string[];

  @Column({ type: 'varchar', length: 100, name: 'device_name', nullable: true })
  deviceName!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'last_used_at', nullable: true })
  lastUsedAt!: Date | null;
}
