import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * ADR-0023: local password bootstrap, coexisting with (not replacing) Phase
 * 3's SSO federation. `user_id` is both PK and FK to keep the 1:1
 * relationship explicit - a user has at most one local password credential,
 * same as they have at most one `external_idp_id` on `User`.
 */
@Entity({ schema: 'core', name: 'user_credentials' })
@Index('idx_user_credentials_tenant_id_user_id', ['tenantId', 'userId'])
export class UserCredential {
  @PrimaryColumn({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 255, name: 'password_hash' })
  passwordHash!: string;

  @Column({ type: 'varchar', length: 20, name: 'password_algorithm', default: 'bcrypt' })
  passwordAlgorithm!: string;

  @Column({ type: 'timestamptz', name: 'password_updated_at' })
  passwordUpdatedAt!: Date;

  @Column({ type: 'integer', name: 'failed_login_attempts', default: 0 })
  failedLoginAttempts!: number;

  @Column({ type: 'timestamptz', name: 'locked_until', nullable: true })
  lockedUntil!: Date | null;

  /** Stamped by `PasswordAuthService.authenticate` on every successful local-password login. */
  @Column({ type: 'timestamptz', name: 'last_login_at', nullable: true })
  lastLoginAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
