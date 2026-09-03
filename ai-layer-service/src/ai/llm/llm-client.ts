import { AiLlmProvider } from '../entities/ai-provider-config.entity';

/**
 * Deliberate deviation from §1's "Anthropic only, platform-wide" default
 * (docs/adr/0117): each tenant brings their own provider, model, and API
 * key (`AiProviderConfig`), resolved fresh on every call - never a
 * singleton client holding one tenant's credentials, since a second
 * tenant's request on the same running instance must never see the first
 * tenant's key. `LlmClient` stays provider-agnostic; the one registered
 * implementation (`ProviderRoutingLlmClient`) is where a provider's own
 * SDK/endpoint shape lives.
 *
 * `apiKey` is nullable and `baseUrl` exists at all only because of `ollama`
 * (docs/adr/0129) - a self-hosted provider typically has no key and always
 * needs a caller-supplied endpoint, unlike the three cloud providers, which
 * always have a real `apiKey` and never read `baseUrl`.
 */
export interface ResolvedLlmProvider {
  provider: AiLlmProvider;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
}

export interface LlmCompletionRequest {
  /** Fixed platform-authored instructions - never includes end-user or tenant-authored content (§5.2). */
  systemPrompt: string;
  /** The untrusted content block: retrieved structured data (JSON-serialized) and/or the end user's own NL question. */
  userContent: string;
  maxTokens?: number;
}

export interface LlmCompletionResult {
  text: string;
  /** The bare model identifier the tenant configured - never hardcoded, always echoed from `ResolvedLlmProvider.model`. */
  model: string;
}

export abstract class LlmClient {
  abstract complete(provider: ResolvedLlmProvider, request: LlmCompletionRequest): Promise<LlmCompletionResult>;
}
