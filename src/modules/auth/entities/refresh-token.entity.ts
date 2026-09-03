import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { RefreshTokenStatus } from './refresh-token-status.enum';

/**
 * ADR-0025: `familyId` + `generation` is the reuse-detection mechanism. A
 * successful `refresh_token` grant sets the presented row's status to
 * `rotated` and inserts a new row with the same `familyId` and
 * `generation + 1`. Presenting any row that is not the family's current
 * highest generation (i.e. `status !== 'active'`) means the token was
 * already rotated or revoked - `RefreshTokenService` treats that as reuse
 * and revokes the whole family. Only `tokenHash` (SHA-256) is persisted.
 */
@Entity({ schema: 'core', name: 'refresh_tokens' })
@Index('idx_refresh_tokens_tenant_id_family_id_generation', ['tenantId', 'familyId', 'generation'])
@Index('idx_refresh_tokens_tenant_id_user_id', ['tenantId', 'userId'])
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'family_id' })
  familyId!: string;

  @Column({ type: 'integer' })
  generation!: number;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'client_id' })
  clientId!: string;

  @Column({ type: 'varchar', length: 128, name: 'token_hash' })
  tokenHash!: string;

  @Column({ type: 'varchar', length: 20, default: RefreshTokenStatus.ACTIVE })
  status!: RefreshTokenStatus;

  @Column({ type: 'text', array: true, default: '{}' })
  amr!: string[];

  @Column({ type: 'timestamptz', name: 'auth_time' })
  authTime!: Date;

  @Column({ type: 'text', default: '' })
  scope!: string;

  @Column({ type: 'uuid', name: 'replaced_by_id', nullable: true })
  replacedById!: string | null;

  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'varchar', length: 50, name: 'revoked_reason', nullable: true })
  revokedReason!: string | null;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
