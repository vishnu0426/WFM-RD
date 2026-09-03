import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import {
  WebhookSubscription,
  WebhookSubscriptionStatus,
} from '../../integrations/entities/webhook-subscription.entity';
import { WebhookDelivery } from '../../integrations/entities/webhook-delivery.entity';
import { CreateWebhookSubscriptionResult } from '../webhook-subscriptions.service';

registerEnumType(WebhookSubscriptionStatus, { name: 'WebhookSubscriptionStatus' });

/** §3.1's named field set - never `secretReference` (the Vault-reference-bearing column, same "never expose the credential path itself" posture `IntegrationConnectorResult` already applies to `config`). */
@ObjectType('WebhookSubscription')
export class WebhookSubscriptionResult {
  @Field(() => ID)
  id!: string;

  @Field(() => [String])
  eventTypes!: string[];

  @Field()
  targetUrl!: string;

  @Field(() => WebhookSubscriptionStatus)
  status!: WebhookSubscriptionStatus;

  @Field(() => Number)
  consecutiveFailureCount!: number;
}

/** The raw secret is present here only - `createWebhookSubscription`'s own response, never re-derivable from any other query (ADR-0046's "returned exactly once" posture, extended to this module's Vault-referenced version of it). */
@ObjectType('CreateWebhookSubscriptionResult')
export class CreateWebhookSubscriptionResultType {
  @Field(() => WebhookSubscriptionResult)
  subscription!: WebhookSubscriptionResult;

  @Field()
  secret!: string;
}

@ObjectType('WebhookDelivery')
export class WebhookDeliveryResult {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  webhookSubscriptionId!: string;

  @Field()
  eventType!: string;

  @Field(() => Object, { nullable: true })
  payload!: Record<string, unknown> | null;

  @Field(() => Number, { nullable: true })
  responseStatusCode!: number | null;

  @Field(() => Date, { nullable: true })
  deliveredAt!: Date | null;

  @Field(() => Number)
  retryCount!: number;

  @Field(() => Date)
  createdAt!: Date;
}

export function toWebhookSubscriptionResult(subscription: WebhookSubscription): WebhookSubscriptionResult {
  return {
    id: subscription.id,
    eventTypes: subscription.eventTypes,
    targetUrl: subscription.targetUrl,
    status: subscription.status,
    consecutiveFailureCount: subscription.consecutiveFailureCount,
  };
}

export function toCreateWebhookSubscriptionResultType(
  result: CreateWebhookSubscriptionResult,
): CreateWebhookSubscriptionResultType {
  return {
    subscription: toWebhookSubscriptionResult(result.subscription),
    secret: result.secret,
  };
}

export function toWebhookDeliveryResult(delivery: WebhookDelivery): WebhookDeliveryResult {
  return {
    id: delivery.id,
    webhookSubscriptionId: delivery.webhookSubscriptionId,
    eventType: delivery.eventType,
    payload: delivery.payload,
    responseStatusCode: delivery.responseStatusCode,
    deliveredAt: delivery.deliveredAt,
    retryCount: delivery.retryCount,
    createdAt: delivery.createdAt,
  };
}
