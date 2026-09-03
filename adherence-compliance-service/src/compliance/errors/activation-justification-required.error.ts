import { DomainError } from '../../common/errors/domain-error';

/**
 * §5a's override posture: activating despite a flagged (`wouldBecomeNoncompliantCount
 * > 0`) preview is allowed, but must be a deliberate, documented decision, not
 * a silent one-click override — enforced here, not just trusted to the
 * frontend's own confirmation step, the same "server is the actual boundary"
 * posture every other validation in this service already takes.
 */
export class ActivationJustificationRequiredError extends DomainError {
  constructor(ruleId: string) {
    super(
      'ACTIVATION_JUSTIFICATION_REQUIRED',
      `Compliance rule ${ruleId} has a preview flagging non-compliant schedules — activating anyway requires a non-empty justificationNote.`,
    );
  }
}
