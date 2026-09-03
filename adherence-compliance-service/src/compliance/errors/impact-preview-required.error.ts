import { DomainError } from '../../common/errors/domain-error';

/**
 * §5a/docs/adr/0104: `activateRule` only ever transitions a rule "after the
 * admin has reviewed a RuleChangeImpactPreview" (`compliance-rule.entity.ts`'s
 * own doc comment) - enforced here as "at least one preview row must exist
 * for this rule," not merely "the caller claims to have looked at one."
 */
export class ImpactPreviewRequiredError extends DomainError {
  constructor(ruleId: string) {
    super(
      'IMPACT_PREVIEW_REQUIRED',
      `Compliance rule ${ruleId} cannot be activated until a RuleChangeImpactPreview has been generated for it.`,
    );
  }
}
