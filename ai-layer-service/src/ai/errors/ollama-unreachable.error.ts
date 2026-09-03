import { DomainError } from '../../common/errors/domain-error';

/**
 * Thrown by `AiProviderConfigService.configure` when `OllamaReachabilityChecker`
 * can't reach the tenant-supplied `baseUrl` at configuration time
 * (docs/adr/0129/0133). A caller-fixable error (wrong host, unreachable
 * network, instance not running yet) - mapped to 400, not 503, since the
 * failure is about the tenant's own supplied value, not this service's own
 * health.
 */
export class OllamaUnreachableError extends DomainError {
  constructor(baseUrl: string, reason: string) {
    super('OLLAMA_UNREACHABLE', `Could not reach Ollama at "${baseUrl}": ${reason}`);
  }
}
