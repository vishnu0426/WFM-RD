import { DomainError } from '../../../common/errors/domain-error';

/** Any non-2xx/network failure against NICE CXone's own REST/long-poll surface (auth or `get-next-event`) - a real long-poll *timeout* (no event within the hold window) is not this error, it's the comet pattern's own expected empty-response outcome. */
export class NiceCxoneApiError extends DomainError {
  constructor(cause: string) {
    super('NICE_CXONE_API_ERROR', `NICE CXone API call failed: ${cause}`);
  }
}
