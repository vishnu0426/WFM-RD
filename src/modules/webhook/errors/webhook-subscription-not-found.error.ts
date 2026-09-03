import { NotFoundError } from '../../../common/errors/not-found.error';

export class WebhookSubscriptionNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('WebhookSubscription', id);
  }
}
