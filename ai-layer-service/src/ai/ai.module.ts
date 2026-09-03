import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiInteraction, AiRecommendation, AiGovernancePolicy, AiProviderConfig } from '../database/entities';
import { SchedulingGrpcClientModule } from '../grpc/scheduling-grpc-client.module';
import { ForecastingGrpcClientModule } from '../grpc/forecasting-grpc-client.module';
import { IntradayGrpcClientModule } from '../grpc/intraday-grpc-client.module';
import { ComplianceGrpcClientModule } from '../grpc/compliance-grpc-client.module';
import { AuditGrpcClientModule } from '../grpc/audit-grpc-client.module';
import { AiNatsClientModule } from '../nats/ai-nats-client.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { TenantScopeAssertionService } from './tenant-scope-assertion.service';
import { SchedulingWritebackClientService } from './scheduling-writeback-client.service';
import { ScheduleExplanationService } from './schedule-explanation.service';
import { ForecastExplanationService } from './forecast-explanation.service';
import { ReallocationRationaleService } from './reallocation-rationale.service';
import { RootCauseAnalysisService } from './root-cause-analysis.service';
import { AiProviderConfigService } from './ai-provider-config.service';
import { AiProviderCredentialCipherService } from './security/ai-provider-credential-cipher.service';
import { OllamaReachabilityChecker } from './ollama-reachability-checker';
import { AiGovernancePolicyResolverService } from './ai-governance-policy-resolver.service';
import { AiGovernancePolicyService } from './ai-governance-policy.service';
import { RiskThresholdEvaluatorService } from './risk-threshold-evaluator.service';
import { ReallocationExecutionClientService } from './reallocation-execution-client.service';
import { AiRecommendationEventPublisherService } from './ai-recommendation-event-publisher.service';
import { AiRecommendationService } from './ai-recommendation.service';
import { AiInteractionQueryService } from './ai-interaction-query.service';
import { AskQuestionService } from './ask-question.service';
import { NlAnalyticsBridgeService } from './nl-analytics-bridge.service';
import { AuthModule } from '../auth/auth.module';
import { LlmClient } from './llm/llm-client';
import { ProviderRoutingLlmClient } from './llm/provider-routing-llm-client.service';
import { LlmCircuitBreakerService } from './llm/llm-circuit-breaker.service';

/**
 * Phase 1/2: `AIInteraction`/`AIRecommendation`/`AIGovernancePolicy`
 * repositories (via `TypeOrmModule.forFeature`, even though only
 * `AIInteraction` has a writer yet - `AIRecommendation`/
 * `AIGovernancePolicy` land in Phase 5) plus the `explainSchedule` pipeline
 * and the BYOK provider-configuration pipeline (docs/adr/0117).
 *
 * Phase 4 (docs/adr/0119/0120/0121/0122) adds `explainForecast`/
 * `explainReallocation`/`rootCauseAnalysis` - three more gRPC clients
 * (forecasting/intraday/compliance), each backed by a new gRPC surface
 * this phase added to its owning service.
 *
 * Phase 5 (docs/adr/0123/0124/0125) adds §3's governance resolution
 * (`AiGovernancePolicyResolverService`/`AiGovernancePolicyService`), the
 * concrete `auto_execute_low_risk` gate (`RiskThresholdEvaluatorService`),
 * the `AIRecommendation` lifecycle (`AiRecommendationService`), its NATS
 * event publication (`AiNatsClientModule`, this service's first NATS
 * presence), and the write-back-through-owning-module execution pathway
 * for `recommendation_type: 'reallocation'` (`ReallocationExecutionClientService`).
 *
 * Phase 6 (docs/adr/0126/0127) adds `askQuestion` (`AskQuestionService`),
 * built on top of the four explanation/analysis services' own
 * `gatherContext` methods rather than a fifth gRPC fetch-path.
 *
 * Phase 7 (docs/adr/0128) adds `LlmCircuitBreakerService`, gating every
 * `ProviderRoutingLlmClient.complete` call - short-circuits into the same
 * `LlmCallFailedError`/degraded-mode path every interaction-generating
 * service already handles, so none of them needed any change at all.
 *
 * `LlmClient` is bound to `ProviderRoutingLlmClient` here - the one place in
 * this module a future provider addition (or, more immediately, a test
 * double) would touch, same "provider interface, swappable implementation"
 * shape ADR-0111 established for `NlQueryBridgeClient`. Unlike that
 * precedent, `ProviderRoutingLlmClient` is real and live for both
 * registered providers - there is no "not available yet" stub here, since
 * an LLM provider is this module's own core competency.
 *
 * ADR-0165 adds `NlAnalyticsBridgeService` - this module's first inbound
 * capability (called by `NlQueryBridgeGrpcController`, not by any resolver
 * in this service's own `graphql/`), closing Module 09's `askAnalyticsQuestion`
 * gap ADR-0111 disclosed. Imports `AuthModule` for `AiInteractionRateLimiterService`
 * - the same limiter instance/keying `AiInteractionRateLimitGuard` already
 * enforces for every GraphQL-originated `AIInteraction` call, reused
 * directly here since a gRPC controller has no Guard pipeline of its own.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AiInteraction, AiRecommendation, AiGovernancePolicy, AiProviderConfig]),
    SchedulingGrpcClientModule,
    ForecastingGrpcClientModule,
    IntradayGrpcClientModule,
    ComplianceGrpcClientModule,
    AuditGrpcClientModule,
    AiNatsClientModule,
    MetricsModule,
    AuthModule,
  ],
  providers: [
    TenantScopeAssertionService,
    SchedulingWritebackClientService,
    ScheduleExplanationService,
    ForecastExplanationService,
    ReallocationRationaleService,
    RootCauseAnalysisService,
    AiProviderConfigService,
    AiProviderCredentialCipherService,
    OllamaReachabilityChecker,
    AiGovernancePolicyResolverService,
    AiGovernancePolicyService,
    RiskThresholdEvaluatorService,
    ReallocationExecutionClientService,
    AiRecommendationEventPublisherService,
    AiRecommendationService,
    AiInteractionQueryService,
    AskQuestionService,
    NlAnalyticsBridgeService,
    LlmCircuitBreakerService,
    { provide: LlmClient, useClass: ProviderRoutingLlmClient },
  ],
  exports: [
    ScheduleExplanationService,
    ForecastExplanationService,
    ReallocationRationaleService,
    RootCauseAnalysisService,
    TenantScopeAssertionService,
    AiProviderConfigService,
    AiGovernancePolicyService,
    AiRecommendationService,
    AiInteractionQueryService,
    AskQuestionService,
    NlAnalyticsBridgeService,
  ],
})
export class AiModule {}
