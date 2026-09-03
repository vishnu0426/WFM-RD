import { WebhookSubscription } from '../entities/webhook-subscription.entity';

export interface WebhookSubscriptionView {
  id: string;
  url: string;
  description: string | null;
  subscribedSubjects: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Never includes `secret` - readable exactly once, in the `POST` response, at creation time (§3.2's webhook-signing-secret posture). */
export function toWebhookSubscriptionView(subscription: WebhookSubscription): WebhookSubscriptionView {
  return {
    id: subscription.id,
    url: subscription.url,
    description: subscription.description,
    subscribedSubjects: subscription.subscribedSubjects,
    isActive: subscription.isActive,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  };
}
