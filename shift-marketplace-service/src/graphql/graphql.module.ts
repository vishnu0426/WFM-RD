import { join } from 'path';
import { Module } from '@nestjs/common';
import { GraphQLModule as NestGraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLFormattedError } from 'graphql';
import { DomainError } from '../common/errors/domain-error';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { AuthModule } from '../auth/auth.module';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { JsonScalar } from './json.scalar';
import { GraphQLPubSubModule } from './pubsub.module';
import { MarketplacePostResolver } from './resolvers/marketplace-post.resolver';
import { SwapRequestResolver } from './resolvers/swap-request.resolver';
import { BidResolver } from './resolvers/bid.resolver';
import { ApproveMarketplaceActionResolver } from './resolvers/approve-marketplace-action.resolver';
import { MarketplaceEngagementResolver } from './resolvers/marketplace-engagement.resolver';
import { MarketplaceApprovalQueueResolver } from './resolvers/marketplace-approval-queue.resolver';
import { MarketplaceHealthResolver } from './resolvers/marketplace-health.resolver';

/** GraphQL-side counterpart to `DomainErrorFilter` (REST) - own copy of intraday-service's `formatGraphQLError`. */
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
 * Phase 2 (§3.1): this service's primary API surface, and this platform's
 * second GraphQL *subscription* surface (intraday-service's was the
 * first). `subscriptions: { 'graphql-ws': {} }` - `graphql-ws`, not the
 * deprecated `subscriptions-transport-ws`, already a transitive dependency
 * of `@nestjs/graphql` at the version this platform pins.
 */
@Module({
  imports: [
    NestGraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      sortSchema: true,
      formatError: formatGraphQLError,
      subscriptions: { 'graphql-ws': {} },
      context: ({ req }: { req: unknown }) => ({ req }),
    }),
    GraphQLPubSubModule,
    TenantContextModule,
    MetricsModule,
    MarketplaceModule,
    AuthModule,
  ],
  providers: [
    JsonScalar,
    MarketplacePostResolver,
    SwapRequestResolver,
    BidResolver,
    ApproveMarketplaceActionResolver,
    MarketplaceEngagementResolver,
    MarketplaceApprovalQueueResolver,
    MarketplaceHealthResolver,
    // Re-listed here (in addition to importing AuthModule) - a guard
    // referenced via @UseGuards(SomeGuard) resolves using the *consuming*
    // module's own injector, same DI quirk AuthModule's own doc comment
    // discloses. Re-listing the guard classes alone isn't sufficient
    // either - AccessTokenGuard's own MetricsService dependency needs its
    // module (MetricsModule) imported directly here too, not just
    // transitively through AuthModule; this was the actual missing piece
    // (a real boot failure caught live, not a guess - "Nest can't resolve
    // dependencies of the AccessTokenGuard... MetricsService... in
    // MarketplaceGraphQLModule context").
    AccessTokenGuard,
    PermissionsGuard,
    TenantTokenMatchGuard,
  ],
})
export class MarketplaceGraphQLModule {}
