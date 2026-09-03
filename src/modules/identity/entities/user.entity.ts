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
import { UserStatus } from './user-status.enum';

@Entity({ schema: 'core', name: 'users' })
@Index('uq_users_tenant_id_id', ['tenantId', 'id'], { unique: true })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 255, name: 'external_idp_id', nullable: true })
  externalIdpId!: string | null;

  @Column({ type: 'varchar', length: 320 })
  email!: string;

  @Column({ type: 'varchar', length: 20, default: UserStatus.INVITED })
  status!: UserStatus;

  @Column({ type: 'boolean', name: 'mfa_enabled', default: false })
  mfaEnabled!: boolean;

  /** Phase 3 (§5.3): SCIM's `name.givenName`/`name.familyName` - see the migration's own doc comment. */
  @Column({ type: 'varchar', length: 100, name: 'given_name', nullable: true })
  givenName!: string | null;

  @Column({ type: 'varchar', length: 100, name: 'family_name', nullable: true })
  familyName!: string | null;

  /**
   * Optional per-tenant login handle (frontend Phase 8 follow-up), set via
   * `PATCH /v1/users/:id/username`. Unlike `email`, NOT normalized here -
   * the tenant-scoped uniqueness index (`uq_users_tenant_id_username_lower`)
   * is on `lower(username)`, and lookups (`UsersRepository.findByUsername`)
   * compare case-insensitively at query time instead, so the stored value
   * keeps whatever casing an admin typed.
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  username!: string | null;

  /** Platform Admin onboarding's Primary Admin step - optional contact detail, not used for authentication. */
  @Column({ type: 'varchar', length: 30, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 100, name: 'job_title', nullable: true })
  jobTitle!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  /**
   * The tenant-scoped uniqueness index (uq_users_tenant_id_email) is on
   * lower(email); normalizing here keeps the stored value and the lookup
   * value (UsersRepository.findByEmail) trivially consistent instead of
   * relying on every call site to remember to lowercase.
   */
  @BeforeInsert()
  @BeforeUpdate()
  normalizeEmail(): void {
    this.email = this.email.toLowerCase();
  }
}
