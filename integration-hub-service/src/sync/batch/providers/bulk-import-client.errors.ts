import { DomainError } from '../../../common/errors/domain-error';

export class BulkImportClientUnavailableError extends DomainError {
  constructor(operation: string, cause: string) {
    super('BULK_IMPORT_CLIENT_UNAVAILABLE', `Module 02 bulk-import ${operation} failed: ${cause}`);
  }
}

export class BulkImportJobTimeoutError extends DomainError {
  constructor(jobId: string) {
    super(
      'BULK_IMPORT_JOB_TIMEOUT',
      `Module 02 bulk-import job "${jobId}" did not reach a terminal status within the poll budget.`,
    );
  }
}
