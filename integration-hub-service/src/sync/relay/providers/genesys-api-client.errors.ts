import { DomainError } from '../../../common/errors/domain-error';

/** Any non-2xx/network failure across the three real REST calls Genesys Cloud's own Notifications API requires before a WebSocket can be opened: OAuth token, channel creation, topic subscription (docs/module-12-provider-research.md's Genesys Cloud section). */
export class GenesysApiError extends DomainError {
  constructor(cause: string) {
    super('GENESYS_API_ERROR', `Genesys Cloud API call failed: ${cause}`);
  }
}
