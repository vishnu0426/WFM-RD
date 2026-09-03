import { DomainError } from '../../../common/errors/domain-error';

/** §2.2 rule 3: any write with actor_type = ai_agent must carry ai_rationale. */
export class AiRationaleRequiredError extends DomainError {
  readonly code = 'AI_RATIONALE_REQUIRED';

  constructor() {
    super('ai_rationale is required on every audit_log entry where actorType is "ai_agent".');
  }
}
