import { DomainError } from '../../common/errors/domain-error';

export class CcQueueNotFoundError extends DomainError {
  constructor(ccQueueId: string) {
    super('CC_QUEUE_NOT_FOUND', `No forecasting-service CcQueue found with id "${ccQueueId}" for this tenant.`);
  }
}
