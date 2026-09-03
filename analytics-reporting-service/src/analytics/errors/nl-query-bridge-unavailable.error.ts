import { DomainError } from '../../common/errors/domain-error';

/**
 * ADR-0165: thrown by `GrpcNlQueryBridgeClient` when Module 10's
 * `NlQueryBridgeService` either could not be reached at all
 * (`AiLayerGrpcClientUnavailableError` - a real network/timeout failure)
 * or reached and responded with `errorCode: "UNAVAILABLE"` (Module 10's
 * own degraded-mode path - no LLM provider configured for this tenant, or
 * the configured provider's API call failed). Either way, the caller gets
 * the same honest, typed 503 - never a fabricated translation or answer.
 * (Superseded ADR-0111's original meaning of this class - "Module 10 does
 * not exist in this platform" - now that it does.)
 */
export class NlQueryBridgeUnavailableError extends DomainError {
  constructor() {
    super('NL_QUERY_BRIDGE_UNAVAILABLE', 'The analytics AI assistant is temporarily unavailable.');
  }
}
