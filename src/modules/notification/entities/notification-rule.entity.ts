import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { NotificationChannel } from './notification-channel.enum';

/**
 * System Configuration gap-fix: `NotificationPreference` is per-user only
 * (`findForUser`) — there was no tenant-wide "when event X fires, is
 * channel Y on by default" concept anywhere. This is that tenant-wide
 * default, consulted by `NotificationService.enqueue` only for a
 * (user, eventType, channel) combination the user has no explicit
 * `NotificationPreference` row for — an explicit user preference always
 * wins over the tenant default, same precedence a real notification system
 * would have.
 *
 * `eventType` stays a free string (varchar, no enum/FK) — same posture as
 * `NotificationPreference.eventType` and `NotificationDelivery.eventType`,
 * since there is genuinely no event-type catalog anywhere in this platform
 * (only `skill_expiring` has a real producer today).
 */
@Entity({ schema: 'core', name: 'notification_rules' })
@Index('idx_notification_rules_tenant_id', ['tenantId'])
@Index('uq_notification_rules_tenant_event_channel', ['tenantId', 'eventType', 'channel'], { unique: true })
export class NotificationRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 100, name: 'event_type' })
  eventType!: string;

  @Column({ type: 'varchar', length: 20 })
  channel!: NotificationChannel;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
