import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * §3.2's webhook signing secrets (ADR-0046). `secret` is plaintext, not a
 * hash - see the migration's own doc comment for why (this platform signs
 * outbound deliveries with it, unlike a password/OAuth secret it only ever
 * verifies a caller-presented value against).
 */
@Entity({ schema: 'core', name: 'webhook_subscriptions' })
@Index('idx_webhook_subscriptions_tenant_id', ['tenantId'])
export class WebhookSubscription {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 2048 })
  url!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 255 })
  secret!: string;

  @Column({ type: 'text', array: true, name: 'subscribed_subjects' })
  subscribedSubjects!: string[];

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
