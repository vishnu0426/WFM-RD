import { join } from 'path';
import { Module } from '@nestjs/common';
import { GraphQLModule as NestGraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLFormattedError } from 'graphql';
import { AlertingModule } from '../alerting/alerting.module';
import { DomainError } from '../common/errors/domain-error';
import { IngestionModule } from '../ingestion/ingestion.module';
import { LiveStateModule } from '../live-state/live-state.module';
import { ReallocationModule } from '../reallocation/reallocation.module';
import { JsonScalar } from './json.scalar';
import { GraphQLPubSubModule } from './pubsub.module';
import { AgentLiveStateResolver } from './resolvers/agent-live-state.resolver';
import { AlertResolver } from './resolvers/alert.resolver';
import { ReallocationResolver } from './resolvers/reallocation.resolver';
import { QueueLiveStateResolver } from './resolvers/queue-live-state.resolver';
import { ActivityChangeResolver } from './resolvers/activity-change.resolver';

/** GraphQL-side counterpart to `DomainErrorFilter` (REST) - copies the root app's own `formatGraphQLError` shape exactly (`app.module.ts`). */
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
 * §8 Phase 4: this service's first GraphQL surface, and this platform's
 * first GraphQL *subscription* surface anywhere (confirmed zero prior
 * precedent - root app's own GraphQL is queries-only). `subscriptions:
 * { 'graphql-ws': {} }` - `graphql-ws`, not the deprecated
 * `subscriptions-transport-ws`, already a transitive dependency of
 * `@nestjs/graphql` at the version this platform pins.
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
    LiveStateModule,
    IngestionModule,
    GraphQLPubSubModule,
    AlertingModule,
    ReallocationModule,
  ],
  providers: [
    JsonScalar,
    AgentLiveStateResolver,
    QueueLiveStateResolver,
    ActivityChangeResolver,
    AlertResolver,
    ReallocationResolver,
  ],
})
export class IntradayGraphQLModule {}
