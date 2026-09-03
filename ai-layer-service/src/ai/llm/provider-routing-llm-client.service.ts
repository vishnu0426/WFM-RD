import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI, ApiError as GeminiApiError } from '@google/genai';
import { Ollama } from 'ollama';
import { LlmClient, LlmCompletionRequest, LlmCompletionResult, ResolvedLlmProvider } from './llm-client';
import { LlmCallFailedError } from './llm-call-failed.error';
import { LlmCircuitBreakerService } from './llm-circuit-breaker.service';
import { AiLlmProvider } from '../entities/ai-provider-config.entity';
import { MetricsService } from '../../common/metrics/metrics.service';

const DEFAULT_MAX_TOKENS = 1024;
const CALL_TIMEOUT_MS = 20_000;

/** Status codes that mean "this tenant's own key/request is the problem," not "this provider is down" - see `LlmCircuitBreakerService`'s own doc comment for why these must never count toward opening a platform-wide circuit. */
const TENANT_SPECIFIC_STATUS_CODES = new Set([400, 401, 403, 404, 422]);

/**
 * `ollama`'s own JS client (`node_modules/ollama`) has no built-in
 * per-call timeout option and doesn't export its internal `ResponseError`
 * class (only the `ErrorResponse` shape, not the thrown error type) - this
 * marks a call this file's own `Promise.race` timed out, so it can still be
 * classified as a real (`408`-equivalent) provider-side failure rather than
 * falling through as an unrecognized error shape.
 */
class OllamaCallTimeoutError extends Error {}

function extractStatus(err: unknown): number | undefined {
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError || err instanceof GeminiApiError) {
    return err.status;
  }
  if (err instanceof OllamaCallTimeoutError) {
    return 408;
  }
  // `ollama`'s own ResponseError class isn't exported (see the class doc
  // comment above) - duck-type its one distinguishing field instead of
  // giving up on classifying it at all.
  if (
    err &&
    typeof err === 'object' &&
    'status_code' in err &&
    typeof (err as { status_code: unknown }).status_code === 'number'
  ) {
    return (err as { status_code: number }).status_code;
  }
  return undefined;
}

function isCountableFailure(err: unknown): boolean {
  const status = extractStatus(err);
  // A network error, a below-the-SDK timeout, or an unexpected response
  // shape (e.g. `completeWithAnthropic`'s own "no text content block"
  // case) all resolve `status` to `undefined` - none of those have a
  // tenant-specific explanation, so treat them as a provider-side signal.
  return status === undefined || !TENANT_SPECIFIC_STATUS_CODES.has(status);
}

function requireApiKey(provider: ResolvedLlmProvider): string {
  if (!provider.apiKey) {
    throw new Error(`${provider.provider} requires an API key, but none is configured`);
  }
  return provider.apiKey;
}

/**
 * The only `LlmClient` implementation registered in `AiModule` - real,
 * calling the live provider API the tenant configured, never a stub.
 * Stateless: a fresh provider SDK client is constructed per call from the
 * `ResolvedLlmProvider` credentials `AiProviderConfigService` just decrypted
 * - cheap (an HTTP client wrapper, not a connection pool) and the only safe
 * way to guarantee tenant A's key is never reachable from tenant B's
 * request on the same running instance (docs/adr/0117).
 *
 * §1: the model identifier always comes from `ResolvedLlmProvider.model`
 * (the tenant's own configured value) - this file has no hardcoded model
 * id, context window, price, or rate limit for any provider. Every branch
 * fails into the same `LlmCallFailedError`, which is what routes a caller
 * into §4's degraded-mode path - provider choice is invisible to that
 * failure handling.
 *
 * Phase 7 (docs/adr/0128): every call is gated by `LlmCircuitBreakerService`
 * before the network is ever touched. A short-circuited call throws the
 * same `LlmCallFailedError` a real failed call would - every existing
 * interaction-generating service's own degraded-mode `catch` block needs no
 * changes at all to benefit from the breaker.
 *
 * docs/adr/0129 adds `gemini` (a third cloud provider, same BYOK shape as
 * `anthropic`/`openai`) and `ollama` (a self-hosted provider - `baseUrl`,
 * not a platform-fixed endpoint, and typically no `apiKey` at all).
 */
@Injectable()
export class ProviderRoutingLlmClient extends LlmClient {
  private readonly logger = new Logger(ProviderRoutingLlmClient.name);

  constructor(
    private readonly metrics: MetricsService,
    private readonly circuitBreaker: LlmCircuitBreakerService,
  ) {
    super();
  }

  async complete(provider: ResolvedLlmProvider, request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const gate = this.circuitBreaker.beforeCall(provider.provider);
    if (gate.shortCircuited) {
      this.metrics.recordLlmApiCall('short_circuited');
      throw new LlmCallFailedError(
        new Error(`circuit open for ${provider.provider} - short-circuited without attempting a real API call`),
        provider.provider,
      );
    }

    try {
      const result = await this.dispatch(provider, request);
      this.circuitBreaker.recordSuccess(provider.provider);
      this.metrics.recordLlmApiCall('success');
      return result;
    } catch (err) {
      const isTimeout = extractStatus(err) === 408;
      this.circuitBreaker.recordFailure(provider.provider, isCountableFailure(err));
      this.metrics.recordLlmApiCall(isTimeout ? 'timeout' : 'error');
      this.logger.warn(`${provider.provider} API call failed: ${(err as Error).message}`);
      throw new LlmCallFailedError(err, provider.provider);
    }
  }

  private dispatch(provider: ResolvedLlmProvider, request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    switch (provider.provider) {
      case AiLlmProvider.OPENAI:
        return this.completeWithOpenAi(provider, request);
      case AiLlmProvider.GEMINI:
        return this.completeWithGemini(provider, request);
      case AiLlmProvider.OLLAMA:
        return this.completeWithOllama(provider, request);
      default:
        return this.completeWithAnthropic(provider, request);
    }
  }

  private async completeWithAnthropic(
    provider: ResolvedLlmProvider,
    request: LlmCompletionRequest,
  ): Promise<LlmCompletionResult> {
    const client = new Anthropic({ apiKey: requireApiKey(provider) });
    const response = await client.messages.create(
      {
        model: provider.model,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: request.systemPrompt,
        // §5.2: the untrusted content block, never concatenated into the system string.
        messages: [{ role: 'user', content: request.userContent }],
      },
      { timeout: CALL_TIMEOUT_MS },
    );
    const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === 'text');
    if (!textBlock) {
      throw new Error('Anthropic response contained no text content block');
    }
    return { text: textBlock.text, model: provider.model };
  }

  private async completeWithOpenAi(
    provider: ResolvedLlmProvider,
    request: LlmCompletionRequest,
  ): Promise<LlmCompletionResult> {
    const client = new OpenAI({ apiKey: requireApiKey(provider), timeout: CALL_TIMEOUT_MS });
    const response = await client.chat.completions.create({
      model: provider.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [
        { role: 'system', content: request.systemPrompt },
        // §5.2: the untrusted content block, never folded into the system message.
        { role: 'user', content: request.userContent },
      ],
      response_format: { type: 'json_object' },
    });
    const text = response.choices[0]?.message?.content;
    if (!text) {
      throw new Error('OpenAI response contained no message content');
    }
    return { text, model: provider.model };
  }

  private async completeWithGemini(
    provider: ResolvedLlmProvider,
    request: LlmCompletionRequest,
  ): Promise<LlmCompletionResult> {
    const client = new GoogleGenAI({ apiKey: requireApiKey(provider), httpOptions: { timeout: CALL_TIMEOUT_MS } });
    const response = await client.models.generateContent({
      model: provider.model,
      // §5.2: the untrusted content block, never folded into `systemInstruction` below.
      contents: request.userContent,
      config: {
        systemInstruction: request.systemPrompt,
        responseMimeType: 'application/json',
        maxOutputTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      },
    });
    const text = response.text;
    if (!text) {
      throw new Error('Gemini response contained no text content');
    }
    return { text, model: provider.model };
  }

  /**
   * docs/adr/0129: `baseUrl` (not a platform-fixed endpoint) is what makes
   * a self-hosted `ollama` instance reachable at all - `AiProviderConfigService.configure`
   * already requires it for this provider, but re-checking here (rather
   * than trusting that invariant silently) matters more than it does for
   * `requireApiKey`: `new Ollama({ host: undefined })` would silently fall
   * back to the client library's own `localhost:11434` default instead of
   * failing loudly, which would be a confusing, wrong-target failure mode
   * for a multi-tenant service that must never guess at a tenant's own
   * network address.
   */
  private async completeWithOllama(
    provider: ResolvedLlmProvider,
    request: LlmCompletionRequest,
  ): Promise<LlmCompletionResult> {
    if (!provider.baseUrl) {
      throw new Error('ollama requires a configured baseUrl');
    }
    const client = new Ollama({
      host: provider.baseUrl,
      // Optional - most self-hosted Ollama instances are unauthenticated;
      // a tenant running one behind an auth proxy can still supply a key.
      headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : undefined,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        client.chat({
          model: provider.model,
          messages: [
            { role: 'system', content: request.systemPrompt },
            // §5.2: the untrusted content block, never folded into the system message.
            { role: 'user', content: request.userContent },
          ],
          format: 'json',
          stream: false,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new OllamaCallTimeoutError('ollama request timed out')), CALL_TIMEOUT_MS);
        }),
      ]);
      const text = response.message?.content;
      if (!text) {
        throw new Error('Ollama response contained no message content');
      }
      return { text, model: provider.model };
    } finally {
      clearTimeout(timer);
    }
  }
}
