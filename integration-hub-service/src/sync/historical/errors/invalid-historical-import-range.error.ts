import { DomainError } from '../../../common/errors/domain-error';

export class InvalidHistoricalImportRangeError extends DomainError {
  constructor(rangeStart: string, rangeEnd: string) {
    super('INVALID_HISTORICAL_IMPORT_RANGE', `rangeEnd (${rangeEnd}) must not be before rangeStart (${rangeStart}).`);
  }
}
