import { LlmCircuitBreakerService } from '../../../src/ai/llm/llm-circuit-breaker.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { AiLlmProvider } from '../../../src/ai/entities/ai-provider-config.entity';

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 30_000;

describe('LlmCircuitBreakerService', () => {
  let metrics: MetricsService;
  let breaker: LlmCircuitBreakerService;

  beforeEach(() => {
    jest.useFakeTimers();
    metrics = new MetricsService();
    metrics.onModuleInit();
    breaker = new LlmCircuitBreakerService(metrics);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts closed - every call passes through', () => {
    expect(breaker.beforeCall(AiLlmProvider.ANTHROPIC)).toEqual({ shortCircuited: false });
  });

  it('stays closed and does not accumulate across providers independently below the threshold', () => {
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      breaker.recordFailure(AiLlmProvider.ANTHROPIC, true);
    }
    expect(breaker.beforeCall(AiLlmProvider.ANTHROPIC)).toEqual({ shortCircuited: false });
    // A different provider's own state is untouched by Anthropic's failures.
    expect(breaker.beforeCall(AiLlmProvider.OPENAI)).toEqual({ shortCircuited: false });
  });

  it('opens after FAILURE_THRESHOLD consecutive countable failures, short-circuiting subsequent calls', () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure(AiLlmProvider.ANTHROPIC, true);
    }
    expect(breaker.beforeCall(AiLlmProvider.ANTHROPIC)).toEqual({ shortCircuited: true });
  });

  it('never opens from non-countable (tenant-specific) failures, no matter how many', () => {
    for (let i = 0; i < FAILURE_THRESHOLD * 3; i++) {
      breaker.recordFailure(AiLlmProvider.ANTHROPIC, false);
    }
    expect(breaker.beforeCall(AiLlmProvider.ANTHROPIC)).toEqual({ shortCircuited: false });
  });

  it('a success resets the consecutive-failure count', () => {
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      breaker.recordFailure(AiLlmProvider.ANTHROPIC, true);
    }
    breaker.recordSuccess(AiLlmProvider.ANTHROPIC);
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      breaker.recordFailure(AiLlmProvider.ANTHROPIC, true);
    }
    // Only 4 failures since the reset - still below the threshold of 5.
    expect(breaker.beforeCall(AiLlmProvider.ANTHROPIC)).toEqual({ shortCircuited: false });
  });

  it('stays open until the cooldown elapses, then allows exactly one half-open trial call', () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure(AiLlmProvider.ANTHROPIC, true);
    }
    expect(breaker.beforeCall(AiLlmProvider.ANTHROPIC)).toEqual({ shortCircuited: true });

    jest.advanceTimersByTime(COOLDOWN_MS - 1);
    expect(breaker.beforeCall(AiLlmProvider.ANTHROPIC)).toEqual({ shortCircuited: true });

    jest.advanceTimersByTime(1);
    expect(breaker.beforeCall(AiLlmProvider.ANTHROPIC)).toEqual({ shortCircuited: false });
    // A second concurrent call while the one trial is still in flight is short-circuited.
    expect(breaker.beforeCall(AiLlmProvider.ANTHROPIC)).toEqual({ shortCircuited: true });
  });

  it('a successful half-open trial call closes the circuit', () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure(AiLlmProvider.ANTHROPIC, true);
    }
    jest.advanceTimersByTime(COOLDOWN_MS);
    expect(breaker.beforeCall(AiLlmProvider.ANTHROPIC)).toEqual({ shortCircuited: false });

    breaker.recordSuccess(AiLlmProvider.ANTHROPIC);

    expect(breaker.beforeCall(AiLlmProvider.ANTHROPIC)).toEqual({ shortCircuited: false });
  });

  it('a failed half-open trial call reopens the circuit and restarts the cooldown', () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure(AiLlmProvider.ANTHROPIC, true);
    }
    jest.advanceTimersByTime(COOLDOWN_MS);
    expect(breaker.beforeCall(AiLlmProvider.ANTHROPIC)).toEqual({ shortCircuited: false });

    breaker.recordFailure(AiLlmProvider.ANTHROPIC, true);

    expect(breaker.beforeCall(AiLlmProvider.ANTHROPIC)).toEqual({ shortCircuited: true });
    // The cooldown restarted from the reopen, not the original open - not yet elapsed.
    jest.advanceTimersByTime(COOLDOWN_MS - 1);
    expect(breaker.beforeCall(AiLlmProvider.ANTHROPIC)).toEqual({ shortCircuited: true });
    jest.advanceTimersByTime(1);
    expect(breaker.beforeCall(AiLlmProvider.ANTHROPIC)).toEqual({ shortCircuited: false });
  });

  it('records a metric transition on open, half_open, and closed', () => {
    const spy = jest.spyOn(metrics, 'recordCircuitBreakerTransition');
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure(AiLlmProvider.ANTHROPIC, true);
    }
    expect(spy).toHaveBeenCalledWith('open');

    jest.advanceTimersByTime(COOLDOWN_MS);
    breaker.beforeCall(AiLlmProvider.ANTHROPIC);
    expect(spy).toHaveBeenCalledWith('half_open');

    breaker.recordSuccess(AiLlmProvider.ANTHROPIC);
    expect(spy).toHaveBeenCalledWith('closed');
  });
});
