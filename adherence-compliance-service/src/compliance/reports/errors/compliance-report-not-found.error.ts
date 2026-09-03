import { DomainError } from '../../../common/errors/domain-error';

export class ComplianceReportNotFoundError extends DomainError {
  constructor(reportId: string) {
    super('COMPLIANCE_REPORT_NOT_FOUND', `Compliance report ${reportId} was not found.`);
  }
}
