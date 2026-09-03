import { DomainError } from '../../../common/errors/domain-error';

/** docs/adr/0105: `overtime_audit`/`rest_period_audit`/`regulator_export` each need exactly one org unit to resolve a jurisdiction against (`CalendarService.GetWorkingTimeRules`) - unlike `adherence_summary`, which aggregates by employee and has no such requirement. */
export class OrgUnitScopeRequiredError extends DomainError {
  constructor(reportType: string) {
    super('ORG_UNIT_SCOPE_REQUIRED', `orgUnitScope is required for report type "${reportType}".`);
  }
}
