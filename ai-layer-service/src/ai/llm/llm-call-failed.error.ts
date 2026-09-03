import { DomainError } from '../../common/errors/domain-error';
import { AiLlmProvider } from '../entities/ai-provider-config.entity';

/**
 * Thrown by `ProviderRoutingLlmClient` on any failure reaching or getting a
 * usable response from either registered provider's API (network error,
 * timeout, non-2xx, missing configuration), and by
 * `LlmCircuitBreakerService`'s own short-circuit path (Phase 7) when the
 * breaker is open and no real API call was attempted at all.
 * `ScheduleExplanationService` (and every later phase's own
 * interaction-generating service) catches this specifically to enter §4's
 * degraded-mode path - it is never allowed to propagate as a generic 500 or
 * crash the request.
 *
 * `provider` is optional so every existing spec file's own
 * `new LlmCallFailedError(new Error('...'))` (constructed directly to
 * simulate a failure at the interaction-service level, never through the
 * real client) keeps compiling unchanged - a genuine call site
 * (`ProviderRoutingLlmClient`) always supplies it, fixing what was
 * previously a real bug: the message read "Anthropic API call failed" even
 * when the failing provider was OpenAI (BYOK, docs/adr/0117).
 */
export class LlmCallFailedError extends DomainError {
  constructor(cause: unknown, provider?: AiLlmProvider) {
    const label =
      provider === AiLlmProvider.OPENAI ? 'OpenAI' : provider === AiLlmProvider.ANTHROPIC ? 'Anthropic' : 'LLM';
    super('LLM_CALL_FAILED', `${label} API call failed: ${(cause as Error).message}`);
  }
}
