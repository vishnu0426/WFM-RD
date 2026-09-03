import { join } from 'path';
import { Module } from '@nestjs/common';
import { GraphQLModule as NestGraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLFormattedError } from 'graphql';
import { DomainError } from '../common/errors/domain-error';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { AdherenceModule } from '../adherence/adherence.module';
import { AuthModule } from '../auth/auth.module';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { JsonScalar } from './json.scalar';
import { ComplianceRuleResolver } from './resolvers/compliance-rule.resolver';
import { AdherenceScoreResolver } from './resolvers/adherence-score.resolver';

/** GraphQL-side counterpart to `DomainErrorFilter` (REST) - own copy of shift-marketplace-service's own `formatGraphQLError`. */
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
 * Phase 2 (§3.1): this service's primary API surface for `ComplianceRule`
 * management. No subscriptions - nothing in this module's spec calls for
 * real-time push (unlike shift-marketplace-service's `marketplacePostUpdated`).
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
    ComplianceModule,
    AdherenceModule,
    AuthModule,
  ],
  providers: [
    JsonScalar,
    ComplianceRuleResolver,
    AdherenceScoreResolver,
    // Re-provided here alongside AuthModule (which also provides+exports
    // them) — same fix ai-layer-service's AiGraphQLModule already applied
    // (see that module's own doc comment): NestJS resolves a class
    // referenced via `@UseGuards(SomeGuard)` using the *consuming*
    // module's own injector, and a guard imported only via a sibling
    // module's `exports` doesn't resolve reliably here in practice — this
    // was missing and broke boot (`AccessTokenGuard`'s own `MetricsService`
    // dependency couldn't resolve in ComplianceGraphQLModule's context).
    AccessTokenGuard,
    PermissionsGuard,
    TenantTokenMatchGuard,
  ],
})
export class ComplianceGraphQLModule {}
