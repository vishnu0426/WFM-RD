import { DomainError } from '../../../common/errors/domain-error';

export class TalkdeskApiError extends DomainError {
  constructor(cause: string) {
    super('TALKDESK_API_ERROR', `Talkdesk API call failed: ${cause}`);
  }
}
