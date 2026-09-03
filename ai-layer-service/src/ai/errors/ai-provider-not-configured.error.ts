import { DomainError } from '../../common/errors/domain-error';

/**
 * Thrown by `AiProviderConfigService.resolveForCall` when a tenant has
 * never called `configureAiProvider` - the BYOK equivalent of §4's "the LLM
 * API is unreachable": there is simply nothing to call yet. Caught by
 * every interaction-generating service (`ScheduleExplanationService` and
 * later phases) alongside `LlmCallFailedError`, entering the exact same
 * degraded-mode path - "not configured" and "temporarily down" both mean
 * "no real LLM call happened this time," and a caller shouldn't need to
 * tell them apart to get an honest, non-crashing response.
 */
export class AiProviderNotConfiguredError extends DomainError {
  constructor(tenantId: string) {
    super('AI_PROVIDER_NOT_CONFIGURED', `Tenant "${tenantId}" has not configured an AI provider yet.`);
  }
}
