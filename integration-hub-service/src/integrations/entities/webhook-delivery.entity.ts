import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * §2.1/§4.2. `createdAt` is one addition beyond §2.1's literal column list -
 * see this migration's own doc comment for why an ordering timestamp is
 * needed before `deliveredAt` is ever set.
 */
@Entity({ name: 'webhook_delivery', schema: 'integration_hub' })
export class WebhookDelivery {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'webhook_subscription_id' })
  webhookSubscriptionId!: string;

  @Column('varchar', { name: 'event_type' })
  eventType!: string;

  @Column('jsonb')
  payload!: Record<string, unknown>;

  @Column('integer', { name: 'response_status_code', nullable: true })
  responseStatusCode!: number | null;

  @Column('timestamptz', { name: 'delivered_at', nullable: true })
  deliveredAt!: Date | null;

  @Column('integer', { name: 'retry_count', default: 0 })
  retryCount!: number;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;
}
