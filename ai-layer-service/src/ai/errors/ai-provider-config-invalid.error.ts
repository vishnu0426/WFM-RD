import { DomainError } from '../../common/errors/domain-error';

/**
 * Thrown by `AiProviderConfigService.configure` when the caller-supplied
 * combination of `apiKey`/`baseUrl` doesn't match what the chosen provider
 * actually needs (docs/adr/0129) - `ollama` requires `baseUrl` (a
 * self-hosted provider has no fixed platform endpoint); the three cloud
 * providers (`anthropic`/`openai`/`gemini`) require a real `apiKey`. A
 * caller error, not a downstream failure - mapped to 400.
 */
export class AiProviderConfigInvalidError extends DomainError {
  constructor(reason: string) {
    super('AI_PROVIDER_CONFIG_INVALID', reason);
  }
}
