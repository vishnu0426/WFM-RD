import { Injectable, Logger } from '@nestjs/common';
import { AiLlmProvider } from '../entities/ai-provider-config.entity';
import { MetricsService } from '../../common/metrics/metrics.service';

type CircuitStatus = 'closed' | 'open' | 'half_open';

interface ProviderCircuitState {
  status: CircuitStatus;
  consecutiveFailures: number;
  openedAt: number | null;
  /** Guards against a second concurrent call slipping through while the one half-open trial call is still in flight (Node's event loop yields at every `await`, so a naive status check alone would let both through). */
  trialInFlight: boolean;
}

export interface CircuitGate {
  shortCircuited: boolean;
}

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 30_000;

/**
 * Phase 7 (docs/adr/0128): §4's "full circuit breaker" for LLM outages,
 * keyed by **provider** (`anthropic`/`openai`), not by tenant. A real
 * provider-side outage (5xx, timeout, rate limiting) affects every tenant
 * using that provider identically - short-circuiting platform-wide, once
 * detected, means every subsequent call fails fast (no real 20s-timeout
 * network attempt, `ProviderRoutingLlmClient.CALL_TIMEOUT_MS`) into §4's
 * already-existing degraded-mode path, instead of every tenant's own
 * request independently rediscovering the same outage the slow way.
 *
 * Deliberately NOT keyed by tenant, and deliberately NOT tripped by every
 * failure: `ProviderRoutingLlmClient` classifies each failure before
 * calling `recordFailure` - an auth/bad-request error (401/403/400/404/422)
 * is a single tenant's own bad key or bad model id, not a provider-side
 * signal, and must never be allowed to open a circuit that then degrades
 * every *other* tenant's calls to the same provider. Only failures with no
 * such tenant-specific explanation (5xx, 429, timeout, network errors)
 * count toward the threshold.
 *
 * In-memory, per-process state only - this service runs as a single
 * instance in this build (same as every other service in this platform so
 * far), so there is no shared/distributed circuit state across replicas.
 * A future multi-replica deployment would need a shared store (e.g. Redis)
 * for the breaker to behave consistently across instances; disclosed as a
 * real, not-yet-relevant limitation in the Phase 7 readiness checklist,
 * not silently assumed away.
 */
@Injectable()
export class LlmCircuitBreakerService {
  private readonly logger = new Logger(LlmCircuitBreakerService.name);
  private readonly states = new Map<AiLlmProvider, ProviderCircuitState>();

  constructor(private readonly metrics: MetricsService) {}

  private stateFor(provider: AiLlmProvider): ProviderCircuitState {
    let state = this.states.get(provider);
    if (!state) {
      state = { status: 'closed', consecutiveFailures: 0, openedAt: null, trialInFlight: false };
      this.states.set(provider, state);
    }
    return state;
  }

  /** Call before every attempted LLM API call. A `shortCircuited: true` gate means: do not call the network, throw `LlmCallFailedError` immediately. */
  beforeCall(provider: AiLlmProvider): CircuitGate {
    const state = this.stateFor(provider);

    if (state.status === 'closed') {
      return { shortCircuited: false };
    }

    if (state.status === 'open') {
      if (state.openedAt !== null && Date.now() - state.openedAt >= COOLDOWN_MS) {
        state.status = 'half_open';
        state.trialInFlight = true;
        this.logger.warn(`${provider} circuit half-open: cooldown elapsed, allowing one trial call`);
        this.metrics.recordCircuitBreakerTransition('half_open');
        return { shortCircuited: false };
      }
      return { shortCircuited: true };
    }

    // half_open: only the one in-flight trial call is allowed through.
    if (state.trialInFlight) {
      return { shortCircuited: true };
    }
    state.trialInFlight = true;
    return { shortCircuited: false };
  }

  recordSuccess(provider: AiLlmProvider): void {
    const state = this.stateFor(provider);
    const wasOpenOrHalfOpen = state.status !== 'closed';
    state.status = 'closed';
    state.consecutiveFailures = 0;
    state.openedAt = null;
    state.trialInFlight = false;
    if (wasOpenOrHalfOpen) {
      this.logger.log(`${provider} circuit closed: trial call succeeded`);
      this.metrics.recordCircuitBreakerTransition('closed');
    }
  }

  /** `countable: false` (a tenant-specific auth/bad-request failure) never moves the shared circuit toward open - see this class's own doc comment for why. */
  recordFailure(provider: AiLlmProvider, countable: boolean): void {
    if (!countable) {
      return;
    }
    const state = this.stateFor(provider);
    state.consecutiveFailures += 1;

    if (state.status === 'half_open') {
      // The trial call itself failed - reopen and restart the cooldown.
      state.status = 'open';
      state.openedAt = Date.now();
      state.trialInFlight = false;
      this.logger.warn(`${provider} circuit reopened: half-open trial call failed`);
      this.metrics.recordCircuitBreakerTransition('open');
      return;
    }

    if (state.status === 'closed' && state.consecutiveFailures >= FAILURE_THRESHOLD) {
      state.status = 'open';
      state.openedAt = Date.now();
      this.logger.warn(`${provider} circuit opened: ${state.consecutiveFailures} consecutive countable failures`);
      this.metrics.recordCircuitBreakerTransition('open');
    }
  }
}
