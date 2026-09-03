import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { NotificationChannel } from './notification-channel.enum';

/**
 * tenant_id is denormalized (ADR-0004), validated by a composite FK
 * (tenant_id, user_id) -> users(tenant_id, id).
 */
@Entity({ schema: 'core', name: 'notification_preferences' })
@Index('idx_notification_preferences_tenant_id_user_id', ['tenantId', 'userId'])
export class NotificationPreference {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'varchar', length: 20 })
  channel!: NotificationChannel;

  @Column({ type: 'varchar', length: 100, name: 'event_type' })
  eventType!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'time', name: 'quiet_hours_start', nullable: true })
  quietHoursStart!: string | null;

  @Column({ type: 'time', name: 'quiet_hours_end', nullable: true })
  quietHoursEnd!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
