import { Column, Entity, PrimaryGeneratedColumn, Index } from 'typeorm';
import { NotificationChannel } from './notification-channel.enum';

export enum NotificationDeliveryStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

/**
 * GAP-05 fix (enterprise readiness audit, 2026-08-18): the durable delivery
 * queue `NotificationDeliveryDispatcherService` drains - see
 * `1700000016000-NotificationDeliverySchema` for the full rationale. One row
 * per (recipient, channel) fan-out of a `NotificationService.enqueue` call,
 * matching the shape `NotificationPreference` already implies (a user can
 * have a distinct preference per channel per event type).
 */
@Entity({ schema: 'core', name: 'notification_delivery' })
@Index('idx_notification_delivery_tenant_user', ['tenantId', 'userId'])
export class NotificationDelivery {
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

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 20, default: NotificationDeliveryStatus.PENDING })
  status!: NotificationDeliveryStatus;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'sent_at', nullable: true })
  sentAt!: Date | null;

  /** Lease: set when the dispatcher claims this row; a stale claim is reclaimable - see `NotificationDeliveryRepository.findPendingBatch`. */
  @Column({ type: 'timestamptz', name: 'claimed_at', nullable: true })
  claimedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError!: string | null;
}
