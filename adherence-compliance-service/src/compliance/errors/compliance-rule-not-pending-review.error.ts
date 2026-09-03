import { DomainError } from '../../common/errors/domain-error';

/** §5a: `activateComplianceRule` only ever transitions a `pending_review` row - never re-activates an already-`active`/`superseded`/`rejected` one. */
export class ComplianceRuleNotPendingReviewError extends DomainError {
  constructor(ruleId: string, actualStatus: string) {
    super(
      'COMPLIANCE_RULE_NOT_PENDING_REVIEW',
      `Compliance rule ${ruleId} cannot be activated - its status is "${actualStatus}", not "pending_review".`,
    );
  }
}
