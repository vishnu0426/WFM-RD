import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Thin wrapper over `prom-client`'s `Registry`, same posture as every other
 * service's `MetricsService` in this platform. §8's explicit ask: LLM call
 * latency/error rate, circuit breaker state transitions, tenant-scoping
 * assertion failure rate (a security metric, §0.5's on-call table), and
 * autonomy-level distribution of recommendations by tenant. The circuit
 * breaker/degraded-mode metrics are declared now, real but not yet observed
 * from anywhere (Phase 7 wires the breaker itself) - same "real but not yet
 * wired" posture every other service's Phase 1 `MetricsService` followed
 * for its own first-consumed-later metric.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly registry = new Registry();

  readonly httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP/GraphQL request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP/GraphQL requests',
    labelNames: ['method', 'route', 'status_code'],
    registers: [this.registry],
  });

  /** §0.5: full round-trip including the LLM call, per interaction_type - each carries its own honest budget. */
  readonly aiInteractionDurationSeconds = new Histogram({
    name: 'ai_interaction_duration_seconds',
    help: 'Full query-router round trip duration (gRPC fan-out + LLM call), by interaction_type',
    labelNames: ['interaction_type'],
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30],
    registers: [this.registry],
  });

  /**
   * §0.5: LLM API call outcomes - the on-call page condition ("error rate
   * spiking") reads this. `result: 'short_circuited'` (Phase 7) is a call
   * `LlmCircuitBreakerService` refused before any real network attempt -
   * distinguish it from `'error'` (a real, attempted, failed call) when
   * reading this metric, since a spike in `short_circuited` means the
   * breaker is doing its job, not that the provider is newly failing.
   */
  readonly llmApiCallsTotal = new Counter({
    name: 'ai_llm_api_calls_total',
    help: 'LLM API call outcomes across both BYOK providers (success/error/timeout/short_circuited)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  /** §4: circuit breaker state transitions - wired by Phase 7's `LlmCircuitBreakerService`, keyed by provider (label carried in the log line, not this metric - a provider label was considered and skipped since cardinality here is already just two providers times three states, not worth a third label dimension for this platform-wide breaker). */
  readonly circuitBreakerStateTransitionsTotal = new Counter({
    name: 'ai_circuit_breaker_state_transitions_total',
    help: 'LLM API circuit breaker state transitions (to_open/to_half_open/to_closed)',
    labelNames: ['to_state'],
    registers: [this.registry],
  });

  /** §4: interactions served via the degraded-mode fallback, by interaction_type. */
  readonly degradedModeInteractionsTotal = new Counter({
    name: 'ai_degraded_mode_interactions_total',
    help: 'AIInteraction rows served with degraded_mode = true, by interaction_type',
    labelNames: ['interaction_type'],
    registers: [this.registry],
  });

  /**
   * §5.1/§0.5: "any tenant-scoping verification failure at the query router
   * pages accordingly - a potential security incident, not a routine error."
   * Any non-zero rate here is worth alerting on, not just trending.
   */
  readonly tenantScopeAssertionFailuresTotal = new Counter({
    name: 'ai_tenant_scope_assertion_failures_total',
    help: 'CrossTenantDataAssemblyError occurrences at the query router, by source_module - a security-relevant event',
    labelNames: ['source_module'],
    registers: [this.registry],
  });

  /** §0.5 FinOps: AIInteraction volume per tenant, against whatever plan/quota model the business defines. */
  readonly aiInteractionsTotal = new Counter({
    name: 'ai_interactions_total',
    help: 'AIInteraction rows created, by tenant_id and interaction_type',
    labelNames: ['tenant_id', 'interaction_type'],
    registers: [this.registry],
  });

  /** §0.5: autonomy-level distribution of recommendations by tenant - wired when Phase 5 builds AIRecommendation creation. */
  readonly aiRecommendationsByAutonomyLevelTotal = new Counter({
    name: 'ai_recommendations_by_autonomy_level_total',
    help: 'AIRecommendation creations by tenant_id and resolved autonomy_level',
    labelNames: ['tenant_id', 'autonomy_level'],
    registers: [this.registry],
  });

  /**
   * Phase 9 (docs/adr/0133): recorded directly inside `AccessTokenGuard`/
   * `PermissionsGuard`/`TenantTokenMatchGuard` themselves, not via
   * `HttpMetricsInterceptor` - NestJS Guards run *before* Interceptors in
   * the request lifecycle, so a Guard-thrown rejection never reaches that
   * interceptor at all (a real, disclosed gap named in the Phase 8
   * readiness checklist and dashboard, closed here). `reason` distinguishes
   * "no/invalid token" from "valid token, wrong permission" from "valid
   * token, wrong tenant" - three different on-call implications.
   */
  readonly rbacDenialsTotal = new Counter({
    name: 'ai_rbac_denials_total',
    help: 'RBAC guard rejections, by reason (unauthenticated/forbidden_permission/forbidden_tenant_mismatch)',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  /**
   * ADR-0162: this module's own undisclosed gap, closed - no rate limiting
   * existed anywhere on the five `AIInteraction`-generating operations,
   * each of which incurs a real LLM API cost. Recorded directly inside
   * `AiInteractionRateLimitGuard`, same "guards run before interceptors"
   * reasoning `rbacDenialsTotal` above already documents.
   */
  readonly aiInteractionRateLimitChecksTotal = new Counter({
    name: 'ai_interaction_rate_limit_checks_total',
    help: 'AiInteractionRateLimitGuard token-bucket checks by result (allowed/exceeded)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  onModuleInit(): void {
    collectDefaultMetrics({ register: this.registry });
  }

  getRegistry(): Registry {
    return this.registry;
  }

  observeHttpRequest(method: string, route: string, statusCode: number, durationSeconds: number): void {
    const labels = { method, route, status_code: String(statusCode) };
    this.httpRequestDuration.observe(labels, durationSeconds);
    this.httpRequestsTotal.inc(labels);
  }

  observeAiInteractionDuration(interactionType: string, durationSeconds: number): void {
    this.aiInteractionDurationSeconds.observe({ interaction_type: interactionType }, durationSeconds);
  }

  recordLlmApiCall(result: 'success' | 'error' | 'timeout' | 'short_circuited'): void {
    this.llmApiCallsTotal.inc({ result });
  }

  recordCircuitBreakerTransition(toState: 'open' | 'half_open' | 'closed'): void {
    this.circuitBreakerStateTransitionsTotal.inc({ to_state: toState });
  }

  recordDegradedModeInteraction(interactionType: string): void {
    this.degradedModeInteractionsTotal.inc({ interaction_type: interactionType });
  }

  recordTenantScopeAssertionFailure(sourceModule: string): void {
    this.tenantScopeAssertionFailuresTotal.inc({ source_module: sourceModule });
  }

  recordAiInteraction(tenantId: string, interactionType: string): void {
    this.aiInteractionsTotal.inc({ tenant_id: tenantId, interaction_type: interactionType });
  }

  recordAiRecommendation(tenantId: string, autonomyLevel: string): void {
    this.aiRecommendationsByAutonomyLevelTotal.inc({ tenant_id: tenantId, autonomy_level: autonomyLevel });
  }

  recordRbacDenial(reason: 'unauthenticated' | 'forbidden_permission' | 'forbidden_tenant_mismatch'): void {
    this.rbacDenialsTotal.inc({ reason });
  }

  recordAiInteractionRateLimitCheck(result: 'allowed' | 'exceeded'): void {
    this.aiInteractionRateLimitChecksTotal.inc({ result });
  }
}
