import { DomainError } from '../../../common/errors/domain-error';

/** Any non-2xx/network failure across AXP's own provisioning calls (OAuth2 token, subscription creation) or a failed/rejected WebSocket authentication handshake (docs/module-12-provider-research.md's Avaya Experience Platform section; endpoint shapes sourced live from developers.avayacloud.com per ADR-0167). */
export class AxpApiError extends DomainError {
  constructor(cause: string) {
    super('AXP_API_ERROR', `Avaya Experience Platform API call failed: ${cause}`);
  }
}
