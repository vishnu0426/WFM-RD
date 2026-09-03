import { DomainError } from '../../common/errors/domain-error';

export class WebhookSubscriptionNotFoundError extends DomainError {
  constructor(subscriptionId: string) {
    super(
      'WEBHOOK_SUBSCRIPTION_NOT_FOUND',
      `No WebhookSubscription found with id "${subscriptionId}" for this tenant.`,
    );
  }
}
