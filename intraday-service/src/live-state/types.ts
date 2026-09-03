import { Field, ID, ObjectType } from '@nestjs/graphql';

/**
 * §6.1's staleness contract, made real: every live-state read this service
 * serves (GraphQL query, REST snapshot, and the `queueLiveStateUpdated`
 * subscription push) carries this, so a client can distinguish "this is
 * live, current data" from "this is the last value we had before
 * something went wrong" - never silently one or the other.
 */
@ObjectType('DataFreshness')
export class DataFreshness {
  @Field(() => String)
  status!: 'ok' | 'degraded';

  @Field(() => Date, { nullable: true })
  lastKnownUpdateAt!: Date | null;
}

/**
 * Decorated for GraphQL (`@nestjs/graphql`) but co-located with the
 * live-state domain, not the transport layer - `AgentLiveStateQueryService`
 * returns this directly, and both the GraphQL resolver and (indirectly,
 * via `QueueLiveStateResult`'s twin) the REST controller reuse the same
 * instance rather than mapping into a second, parallel shape.
 */
@ObjectType('AgentLiveState')
export class AgentLiveStateResult {
  @Field(() => ID)
  employeeId!: string;

  @Field(() => String, { nullable: true })
  currentActivity!: string | null;

  @Field(() => Date, { nullable: true })
  activityStartedAt!: Date | null;

  @Field(() => String, { nullable: true })
  scheduledActivity!: string | null;

  @Field(() => String, { nullable: true })
  adherenceStatus!: string | null;

  @Field(() => ID, { nullable: true })
  siteId!: string | null;

  @Field(() => ID, { nullable: true })
  queueId!: string | null;

  @Field(() => DataFreshness)
  dataFreshness!: DataFreshness;
}

@ObjectType('QueueLiveState')
export class QueueLiveStateResult {
  @Field(() => ID)
  queueId!: string;

  @Field(() => Number, { nullable: true })
  currentVolume!: number | null;

  @Field(() => Number, { nullable: true })
  agentsAvailable!: number | null;

  @Field(() => Number, { nullable: true })
  agentsOnCall!: number | null;

  @Field(() => Number, { nullable: true })
  forecastedVolume!: number | null;

  @Field(() => Number, { nullable: true })
  serviceLevelCurrent!: number | null;

  @Field(() => Number, { nullable: true })
  serviceLevelTarget!: number | null;

  @Field(() => DataFreshness)
  dataFreshness!: DataFreshness;
}
