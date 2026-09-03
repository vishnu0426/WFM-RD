import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';
import { SigningKeyStatus } from './signing-key-status.enum';

/**
 * ADR-0024: global platform reference data, like `Permission` - no
 * `tenant_id`, no RLS. `private_key_pem` in plaintext is an explicit Phase 2
 * stand-in for a real KMS/HSM (see the production readiness checklist); this
 * is the single highest-leverage secret in the whole platform (whoever holds
 * it can forge a valid access token for any tenant) and must not be treated
 * as production-ready as-is.
 */
@Entity({ schema: 'core', name: 'signing_keys' })
export class SigningKey {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  kid!: string;

  @Column({ type: 'varchar', length: 10, default: 'RS256' })
  algorithm!: string;

  @Column({ type: 'text', name: 'public_key_pem' })
  publicKeyPem!: string;

  @Column({ type: 'text', name: 'private_key_pem' })
  privateKeyPem!: string;

  @Column({ type: 'varchar', length: 20, default: SigningKeyStatus.ACTIVE })
  status!: SigningKeyStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'retired_at', nullable: true })
  retiredAt!: Date | null;
}
