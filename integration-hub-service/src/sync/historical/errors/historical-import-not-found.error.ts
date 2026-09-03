import { DomainError } from '../../../common/errors/domain-error';

export class HistoricalImportNotFoundError extends DomainError {
  constructor(jobId: string) {
    super('HISTORICAL_IMPORT_NOT_FOUND', `No historical import job found with id "${jobId}" for this tenant.`);
  }
}
