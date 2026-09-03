import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum WebhookSubscriptionStatus {
  ACTIVE = 'active',
  FAILING = 'failing',
  DISABLED = 'disabled',
}

/**
 * §2.2 rule 2: `secretReference` is a Vault reference key, the identical
 * discipline connector credentials follow (ADR-0134) - never an inline
 * HMAC signing secret.
 */
@Entity({ name: 'webhook_subscription', schema: 'integration_hub' })
export class WebhookSubscription {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('text', { name: 'event_types', array: true, default: [] })
  eventTypes!: string[];

  @Column('varchar', { name: 'target_url' })
  targetUrl!: string;

  @Column('varchar', { name: 'secret_reference' })
  secretReference!: string;

  @Column('varchar', { default: WebhookSubscriptionStatus.ACTIVE })
  status!: WebhookSubscriptionStatus;

  @Column('integer', { name: 'consecutive_failure_count', default: 0 })
  consecutiveFailureCount!: number;
}
