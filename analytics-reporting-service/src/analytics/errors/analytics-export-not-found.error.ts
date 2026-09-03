import { DomainError } from '../../common/errors/domain-error';

export class AnalyticsExportNotFoundError extends DomainError {
  constructor(id: string) {
    super('ANALYTICS_EXPORT_NOT_FOUND', `No export "${id}" found for this tenant.`);
  }
}

/** §4.2's `GET .../download` against a still-`pending`/`failed` export - there is no file to redirect to yet. */
export class AnalyticsExportNotReadyError extends DomainError {
  constructor(id: string, status: string) {
    super('ANALYTICS_EXPORT_NOT_READY', `Export "${id}" is "${status}", not "completed" - no file is available yet.`);
  }
}
