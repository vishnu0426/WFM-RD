import { DomainError } from '../../../common/errors/domain-error';

/** BACKEND GAP, surfaced as a real, typed error rather than a fabricated success - see `HistoricalConnectorAdapter`'s own doc comment. */
export class HistoricalImportNotSupportedError extends DomainError {
  constructor(provider: string) {
    super(
      'HISTORICAL_IMPORT_NOT_SUPPORTED',
      `Historical import is not supported for provider "${provider}" - no HistoricalConnectorAdapter is registered for it yet.`,
    );
  }
}
