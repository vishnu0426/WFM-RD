import { DomainError } from '../../common/errors/domain-error';

export class OAuthStateMismatchError extends DomainError {
  constructor() {
    super(
      'OAUTH_STATE_MISMATCH',
      'The "state" parameter does not match this connector\'s pending authorization request.',
    );
  }
}

export class ConnectorNotPendingOAuthSetupError extends DomainError {
  constructor(connectorId: string) {
    super(
      'CONNECTOR_NOT_PENDING_OAUTH_SETUP',
      `Connector "${connectorId}" is not an OAuth connector awaiting a callback (already active, or created via the non-OAuth path).`,
    );
  }
}

export class OAuthTokenExchangeFailedError extends DomainError {
  constructor(cause: string) {
    super('OAUTH_TOKEN_EXCHANGE_FAILED', `OAuth authorization-code exchange failed: ${cause}`);
  }
}
