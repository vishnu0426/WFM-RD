import { DomainError } from './domain-error';

export class InvalidSignatureError extends DomainError {
  constructor(reason: string) {
    super('INVALID_SIGNATURE', `Webhook signature verification failed: ${reason}`);
  }
}
