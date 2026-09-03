import { DomainError } from '../../common/errors/domain-error';

/**
 * §4's degraded-mode contract, but for `askQuestion` specifically: every
 * other interaction type falls back to returning the raw structured data it
 * already retrieved (`degraded_mode: true`, `output_text: null`) because
 * that raw data IS a legitimate (if less friendly) answer on its own. An NL
 * answer has no such non-LLM equivalent - handing back the raw grounding
 * data would not answer the question that was actually asked, and
 * pretending otherwise would violate non-negotiable #2. The underlying
 * `AiInteraction` row is still persisted with `degradedMode: true` before
 * this error is thrown (the attempt happened and is auditable), but the
 * caller gets an explicit, actionable error rather than a silently empty
 * "successful" response - the exact UI copy §9 Phase 6 specifies.
 */
export class AiAssistantUnavailableError extends DomainError {
  constructor() {
    super('AI_ASSISTANT_UNAVAILABLE', 'AI assistant is temporarily unavailable — try the dashboard directly.');
  }
}
