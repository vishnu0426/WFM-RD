import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ApiError as GeminiApiError } from '@google/genai';
import { ProviderRoutingLlmClient } from '../../../src/ai/llm/provider-routing-llm-client.service';
import { LlmCircuitBreakerService } from '../../../src/ai/llm/llm-circuit-breaker.service';
import { LlmCallFailedError } from '../../../src/ai/llm/llm-call-failed.error';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { AiLlmProvider } from '../../../src/ai/entities/ai-provider-config.entity';
import { ResolvedLlmProvider } from '../../../src/ai/llm/llm-client';

const mockAnthropicCreate = jest.fn();
const mockOpenAiCreate = jest.fn();
const mockGeminiGenerate = jest.fn();
const mockOllamaChat = jest.fn();

// Neither call site uses `esModuleInterop` - the real SDK packages set
// `module.exports.default = module.exports` themselves so `import X from
// '...'` resolves correctly against their plain CJS export; the mock below
// must do the same self-reference or the default import resolves to
// `undefined` in both this test file and the production module under test.
jest.mock('@anthropic-ai/sdk', () => {
  const actual = jest.requireActual('@anthropic-ai/sdk');
  const MockAnthropic: unknown = jest.fn().mockImplementation(() => ({ messages: { create: mockAnthropicCreate } }));
  (MockAnthropic as { APIError: unknown; default: unknown }).APIError = actual.APIError;
  (MockAnthropic as { APIError: unknown; default: unknown }).default = MockAnthropic;
  return MockAnthropic;
});

jest.mock('openai', () => {
  const actual = jest.requireActual('openai');
  const MockOpenAI: unknown = jest
    .fn()
    .mockImplementation(() => ({ chat: { completions: { create: mockOpenAiCreate } } }));
  (MockOpenAI as { APIError: unknown; default: unknown }).APIError = actual.APIError;
  (MockOpenAI as { APIError: unknown; default: unknown }).default = MockOpenAI;
  return MockOpenAI;
});

// `@google/genai` and `ollama` both use ordinary named exports (no default
// export, unlike the two SDKs above) - no `esModuleInterop` self-reference
// dance needed here.
jest.mock('@google/genai', () => {
  const actual = jest.requireActual('@google/genai');
  return {
    ...actual,
    GoogleGenAI: jest.fn().mockImplementation(() => ({ models: { generateContent: mockGeminiGenerate } })),
  };
});

jest.mock('ollama', () => {
  const actual = jest.requireActual('ollama');
  return {
    ...actual,
    Ollama: jest.fn().mockImplementation(() => ({ chat: mockOllamaChat })),
  };
});

function fakeApiError(ctor: { prototype: object }, status: number, message: string): Error {
  return Object.assign(Object.create(ctor.prototype), { status, message, name: 'APIError' }) as Error;
}

/** `ollama`'s own `ResponseError` class isn't exported (see `OllamaCallTimeoutError`'s own doc comment in the production file) - duck-type its `status_code` field instead. */
function fakeOllamaError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { status_code: statusCode, name: 'ResponseError' });
}

const ANTHROPIC_PROVIDER: ResolvedLlmProvider = {
  provider: AiLlmProvider.ANTHROPIC,
  model: 'claude-test-model',
  apiKey: 'sk-ant-test',
  baseUrl: null,
};
const OPENAI_PROVIDER: ResolvedLlmProvider = {
  provider: AiLlmProvider.OPENAI,
  model: 'gpt-test-model',
  apiKey: 'sk-oai-test',
  baseUrl: null,
};
const GEMINI_PROVIDER: ResolvedLlmProvider = {
  provider: AiLlmProvider.GEMINI,
  model: 'gemini-test-model',
  apiKey: 'gm-test',
  baseUrl: null,
};
const OLLAMA_PROVIDER: ResolvedLlmProvider = {
  provider: AiLlmProvider.OLLAMA,
  model: 'llama3-test',
  apiKey: null,
  baseUrl: 'http://tenant-ollama.internal:11434',
};

describe('ProviderRoutingLlmClient', () => {
  let metrics: MetricsService;
  let circuitBreaker: LlmCircuitBreakerService;
  let client: ProviderRoutingLlmClient;

  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockOpenAiCreate.mockReset();
    mockGeminiGenerate.mockReset();
    mockOllamaChat.mockReset();
    metrics = new MetricsService();
    metrics.onModuleInit();
    circuitBreaker = new LlmCircuitBreakerService(metrics);
    client = new ProviderRoutingLlmClient(metrics, circuitBreaker);
  });

  it('completes successfully against Anthropic', async () => {
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'hello from claude' }] });

    const result = await client.complete(ANTHROPIC_PROVIDER, { systemPrompt: 'sys', userContent: 'user' });

    expect(result).toEqual({ text: 'hello from claude', model: 'claude-test-model' });
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
  });

  it('completes successfully against OpenAI', async () => {
    mockOpenAiCreate.mockResolvedValue({ choices: [{ message: { content: 'hello from gpt' } }] });

    const result = await client.complete(OPENAI_PROVIDER, { systemPrompt: 'sys', userContent: 'user' });

    expect(result).toEqual({ text: 'hello from gpt', model: 'gpt-test-model' });
    expect(mockOpenAiCreate).toHaveBeenCalledTimes(1);
  });

  it('attributes the failure message to the actual failing provider (fixes the old hardcoded "Anthropic" bug)', async () => {
    mockOpenAiCreate.mockRejectedValue(fakeApiError(OpenAI.APIError, 500, 'server error'));

    await expect(client.complete(OPENAI_PROVIDER, { systemPrompt: 'sys', userContent: 'user' })).rejects.toThrow(
      /^OpenAI API call failed: server error$/,
    );
  });

  it('opens the circuit after 5 countable (5xx) failures, then short-circuits without calling the network again', async () => {
    mockAnthropicCreate.mockRejectedValue(fakeApiError(Anthropic.APIError, 500, 'server error'));

    for (let i = 0; i < 5; i++) {
      await expect(client.complete(ANTHROPIC_PROVIDER, { systemPrompt: 'sys', userContent: 'user' })).rejects.toThrow(
        LlmCallFailedError,
      );
    }
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5);

    await expect(client.complete(ANTHROPIC_PROVIDER, { systemPrompt: 'sys', userContent: 'user' })).rejects.toThrow(
      /short-circuited/,
    );
    // The 6th call never reached the network - short-circuited before any SDK call.
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5);
  });

  it('never opens the circuit from repeated tenant-specific (401) failures', async () => {
    mockAnthropicCreate.mockRejectedValue(fakeApiError(Anthropic.APIError, 401, 'invalid api key'));

    for (let i = 0; i < 10; i++) {
      await expect(client.complete(ANTHROPIC_PROVIDER, { systemPrompt: 'sys', userContent: 'user' })).rejects.toThrow(
        LlmCallFailedError,
      );
    }
    // Every one of the 10 calls actually reached the (mocked) network - never short-circuited.
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(10);
  });

  it('records a timeout metric for a 408 status specifically', async () => {
    const spy = jest.spyOn(metrics, 'recordLlmApiCall');
    mockAnthropicCreate.mockRejectedValue(fakeApiError(Anthropic.APIError, 408, 'timed out'));

    await expect(client.complete(ANTHROPIC_PROVIDER, { systemPrompt: 'sys', userContent: 'user' })).rejects.toThrow(
      LlmCallFailedError,
    );

    expect(spy).toHaveBeenCalledWith('timeout');
  });

  it('records a short_circuited metric distinct from error/timeout once the breaker is open', async () => {
    mockAnthropicCreate.mockRejectedValue(fakeApiError(Anthropic.APIError, 500, 'server error'));
    for (let i = 0; i < 5; i++) {
      await client.complete(ANTHROPIC_PROVIDER, { systemPrompt: 'sys', userContent: 'user' }).catch(() => undefined);
    }

    const spy = jest.spyOn(metrics, 'recordLlmApiCall');
    await expect(client.complete(ANTHROPIC_PROVIDER, { systemPrompt: 'sys', userContent: 'user' })).rejects.toThrow(
      LlmCallFailedError,
    );

    expect(spy).toHaveBeenCalledWith('short_circuited');
  });

  it('a genuinely malformed response (no text block) counts toward opening the circuit, same as a real network failure', async () => {
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'not_text' }] });

    for (let i = 0; i < 5; i++) {
      await expect(client.complete(ANTHROPIC_PROVIDER, { systemPrompt: 'sys', userContent: 'user' })).rejects.toThrow(
        LlmCallFailedError,
      );
    }

    await expect(client.complete(ANTHROPIC_PROVIDER, { systemPrompt: 'sys', userContent: 'user' })).rejects.toThrow(
      /short-circuited/,
    );
  });

  it('completes successfully against Gemini', async () => {
    mockGeminiGenerate.mockResolvedValue({ text: 'hello from gemini' });

    const result = await client.complete(GEMINI_PROVIDER, { systemPrompt: 'sys', userContent: 'user' });

    expect(result).toEqual({ text: 'hello from gemini', model: 'gemini-test-model' });
    expect(mockGeminiGenerate).toHaveBeenCalledTimes(1);
  });

  it('opens the circuit for Gemini after 5 countable (5xx) failures, independently of the other providers', async () => {
    mockGeminiGenerate.mockRejectedValue(fakeApiError(GeminiApiError, 500, 'server error'));

    for (let i = 0; i < 5; i++) {
      await expect(client.complete(GEMINI_PROVIDER, { systemPrompt: 'sys', userContent: 'user' })).rejects.toThrow(
        LlmCallFailedError,
      );
    }
    await expect(client.complete(GEMINI_PROVIDER, { systemPrompt: 'sys', userContent: 'user' })).rejects.toThrow(
      /short-circuited/,
    );
    // A different provider's own circuit is untouched.
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'still fine' }] });
    await expect(client.complete(ANTHROPIC_PROVIDER, { systemPrompt: 'sys', userContent: 'user' })).resolves.toEqual({
      text: 'still fine',
      model: 'claude-test-model',
    });
  });

  it('completes successfully against a self-hosted Ollama instance with no configured apiKey', async () => {
    mockOllamaChat.mockResolvedValue({ message: { content: 'hello from llama' } });

    const result = await client.complete(OLLAMA_PROVIDER, { systemPrompt: 'sys', userContent: 'user' });

    expect(result).toEqual({ text: 'hello from llama', model: 'llama3-test' });
    expect(mockOllamaChat).toHaveBeenCalledTimes(1);
  });

  it('throws before ever calling the client if ollama has no configured baseUrl (never silently falls back to localhost)', async () => {
    await expect(
      client.complete({ ...OLLAMA_PROVIDER, baseUrl: null }, { systemPrompt: 'sys', userContent: 'user' }),
    ).rejects.toThrow(/baseUrl/);
    expect(mockOllamaChat).not.toHaveBeenCalled();
  });

  it("classifies ollama's own unexported ResponseError shape (duck-typed status_code) the same as the other providers", async () => {
    mockOllamaChat.mockRejectedValue(fakeOllamaError(401, 'unauthorized'));

    for (let i = 0; i < 10; i++) {
      await expect(client.complete(OLLAMA_PROVIDER, { systemPrompt: 'sys', userContent: 'user' })).rejects.toThrow(
        LlmCallFailedError,
      );
    }
    // 401 is tenant-specific (per TENANT_SPECIFIC_STATUS_CODES) - never opens the circuit.
    expect(mockOllamaChat).toHaveBeenCalledTimes(10);

    mockOllamaChat.mockRejectedValue(fakeOllamaError(500, 'server error'));
    for (let i = 0; i < 5; i++) {
      await expect(client.complete(OLLAMA_PROVIDER, { systemPrompt: 'sys', userContent: 'user' })).rejects.toThrow(
        LlmCallFailedError,
      );
    }
    await expect(client.complete(OLLAMA_PROVIDER, { systemPrompt: 'sys', userContent: 'user' })).rejects.toThrow(
      /short-circuited/,
    );
  });

  it("ollama's own client has no built-in timeout - the manual race times out at CALL_TIMEOUT_MS and is still classified as a real (timeout) failure", async () => {
    jest.useFakeTimers();
    const spy = jest.spyOn(metrics, 'recordLlmApiCall');
    mockOllamaChat.mockReturnValue(new Promise(() => undefined));

    const completion = client.complete(OLLAMA_PROVIDER, { systemPrompt: 'sys', userContent: 'user' });
    const assertion = expect(completion).rejects.toThrow(LlmCallFailedError);
    await jest.advanceTimersByTimeAsync(20_000);
    await assertion;

    expect(spy).toHaveBeenCalledWith('timeout');
    jest.useRealTimers();
  });
});
