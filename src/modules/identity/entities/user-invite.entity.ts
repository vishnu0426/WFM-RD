import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * Frontend Phase 8 gap-fix: `tokenHash` (SHA-256) is the only representation
 * of the raw invite token ever persisted - see the owning migration's own
 * doc comment for why. `SELECT` is open RLS (mirrors `TenantIdentityProvider`,
 * ADR-0029) since `POST /v1/auth/accept-invite` looks this up before any
 * tenant context exists; every write stays tenant-gated.
 */
@Entity({ schema: 'core', name: 'user_invites' })
@Index('idx_user_invites_tenant_id', ['tenantId'])
export class UserInvite {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', length: 64, name: 'token_hash' })
  tokenHash!: string;

  @Column({ type: 'varchar', length: 320, name: 'invited_email' })
  invitedEmail!: string;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', name: 'accepted_at', nullable: true })
  acceptedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
