import { DomainError } from '../../common/errors/domain-error';

export class NoActiveRelaySessionError extends DomainError {
  constructor(connectorId: string) {
    super('NO_ACTIVE_RELAY_SESSION', `Connector "${connectorId}" has no running streaming relay session to stop.`);
  }
}
