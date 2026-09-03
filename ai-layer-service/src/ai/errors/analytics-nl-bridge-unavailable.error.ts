import { DomainError } from '../../common/errors/domain-error';

/**
 * ADR-0165's own copy of `AiAssistantUnavailableError`'s reasoning: neither
 * `translateQuestion` nor `generateAnswer` has a non-LLM fallback (there is
 * no heuristic way to turn free text into a structured query, and a raw
 * result set is not "an answer" to the question that was actually asked) -
 * the underlying `AiInteraction` row is still persisted with
 * `degradedMode: true` before this is thrown (the attempt happened and is
 * auditable), but the caller gets an explicit, actionable outcome. Reaches
 * `AskAnalyticsQuestionService` (analytics-reporting-service) as
 * `NlQueryBridgeUnavailableError`, not this class directly - the gRPC
 * boundary carries `error_code: "UNAVAILABLE"` (see nl_query_bridge.proto),
 * not a serialized exception.
 */
export class AnalyticsNlBridgeUnavailableError extends DomainError {
  constructor() {
    super('ANALYTICS_NL_BRIDGE_UNAVAILABLE', 'Analytics AI assistant is temporarily unavailable.');
  }
}
