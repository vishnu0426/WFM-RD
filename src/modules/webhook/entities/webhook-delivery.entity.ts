import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { WebhookDeliveryStatus } from './webhook-delivery-status.enum';

/**
 * ADR-0046: one row per (subscription, event) delivery attempt - the
 * durable queue `WebhookDeliveryDispatcherService` drains, structurally the
 * same "durable staging table" idea as `core.pending_audit_events`
 * (ADR-0042) and `core.outbox_events` (ADR-0039), one hop further down the
 * pipeline (NATS -> `WebhookFanoutService` -> this table -> an HTTP POST).
 */
@Entity({ schema: 'core', name: 'webhook_deliveries' })
@Index('idx_webhook_deliveries_tenant_id_status', ['tenantId', 'status'])
export class WebhookDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'subscription_id' })
  subscriptionId!: string;

  @Column({ type: 'varchar', length: 255 })
  subject!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 20, default: WebhookDeliveryStatus.PENDING })
  status!: WebhookDeliveryStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'delivered_at', nullable: true })
  deliveredAt!: Date | null;

  /** GAP-14 lease: set when a poller claims this row, cleared implicitly by leaving `pending` status; a stale claim (see `OUTBOX_CLAIM_LEASE_SECONDS`) is reclaimable. */
  @Column({ type: 'timestamptz', name: 'claimed_at', nullable: true })
  claimedAt!: Date | null;
}
