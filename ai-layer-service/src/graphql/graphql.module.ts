import { join } from 'path';
import { Module } from '@nestjs/common';
import { GraphQLModule as NestGraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLFormattedError } from 'graphql';
import { DomainError } from '../common/errors/domain-error';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { AiInteractionRateLimitGuard } from '../auth/ai-interaction-rate-limit.guard';
import { JsonScalar } from './json.scalar';
import { ScheduleExplanationResolver } from './resolvers/schedule-explanation.resolver';
import { ForecastExplanationResolver } from './resolvers/forecast-explanation.resolver';
import { ReallocationRationaleResolver } from './resolvers/reallocation-rationale.resolver';
import { RootCauseAnalysisResolver } from './resolvers/root-cause-analysis.resolver';
import { AiProviderConfigResolver } from './resolvers/ai-provider-config.resolver';
import { AiRecommendationResolver } from './resolvers/ai-recommendation.resolver';
import { AiInteractionResolver } from './resolvers/ai-interaction.resolver';
import { AiGovernancePolicyResolver } from './resolvers/ai-governance-policy.resolver';
import { AskQuestionResolver } from './resolvers/ask-question.resolver';

/** GraphQL-side counterpart to `DomainErrorFilter` (REST) - own copy of every other service's own `formatGraphQLError`. */
function formatGraphQLError(formattedError: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
  const original =
    error instanceof Error && 'originalError' in error ? (error as { originalError?: unknown }).originalError : error;
  if (original instanceof DomainError) {
    return {
      ...formattedError,
      message: original.message,
      extensions: { code: original.code },
    };
  }
  return formattedError;
}

/**
 * Phase 2 (§6.1 + docs/adr/0117): `explainSchedule` plus the BYOK
 * `aiProviderConfig`/`configureAiProvider` pair. Phase 4 (docs/adr/0119/
 * 0120/0121/0122) adds `explainForecast`/`explainReallocation`/
 * `rootCauseAnalysis`. Phase 5 (docs/adr/0123/0124/0125) adds
 * `pendingRecommendations`/`decideRecommendation`/`updateGovernancePolicy`
 * plus this module's own `createReallocationRecommendation` entry point.
 * Phase 6 (docs/adr/0126/0127) adds `askQuestion`, the last §6.1 operation.
 * Phase 8 (docs/adr/0130) wires `AccessTokenGuard`/`PermissionsGuard`,
 * gating `configureAiProvider`/`updateGovernancePolicy` first - the two
 * this module's own readiness checklists flagged as unprotected since
 * Phase 5. Phase 9 (docs/adr/0133) extends RBAC to every remaining
 * write-adjacent operation: `ai_interaction:write` for the five
 * `AIInteraction`-generating queries (`explainSchedule`/`explainForecast`/
 * `explainReallocation`/`rootCauseAnalysis`/`askQuestion`),
 * `ai_recommendation:read`/`:write`/`:approve` for `pendingRecommendations`/
 * `createReallocationRecommendation`/`decideRecommendation` respectively -
 * and moves the three RBAC guards into their own `AuthModule`, matching
 * every other concern in this service. Three pure-read queries stay
 * deliberately ungated - `aiProviderConfig`/`aiGovernancePolicyHistory`/
 * `aiProviderConfigHistory` (ADR-0132) - reading back a tenant's own
 * already-configured provider/policy (never the key itself) or its own
 * history is no more sensitive than any other tenant-scoped read in this
 * service.
 */
@Module({
  imports: [
    NestGraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      sortSchema: true,
      formatError: formatGraphQLError,
      context: ({ req }: { req: unknown }) => ({ req }),
    }),
    TenantContextModule,
    MetricsModule,
    AiModule,
    AuthModule,
  ],
  providers: [
    JsonScalar,
    ScheduleExplanationResolver,
    ForecastExplanationResolver,
    ReallocationRationaleResolver,
    RootCauseAnalysisResolver,
    AiProviderConfigResolver,
    AiRecommendationResolver,
    AiInteractionResolver,
    AiGovernancePolicyResolver,
    AskQuestionResolver,
    // Re-provided here alongside `AuthModule` (which also provides+exports
    // them, for structural clarity - see that module's own doc comment):
    // NestJS resolves a class referenced via `@UseGuards(SomeGuard)` using
    // the *consuming* module's own injector, and a guard imported only via
    // a sibling module's `exports` did not resolve reliably here in
    // practice (a real, observed DI quirk, not a documented guarantee) -
    // disclosed rather than silently worked around. ADR-0162's
    // AiInteractionRateLimitGuard is re-provided here for the same reason.
    AccessTokenGuard,
    PermissionsGuard,
    TenantTokenMatchGuard,
    AiInteractionRateLimitGuard,
  ],
})
export class AiGraphQLModule {}
