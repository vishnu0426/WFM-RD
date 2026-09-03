import { Field, ID, ObjectType } from '@nestjs/graphql';
import { ReallocationAction } from './entities/reallocation-action.entity';

/** §2.1/§8 Phase 6 - co-located with the domain, same convention as `src/alerting/types.ts`. */
@ObjectType('ReallocationAction')
export class ReallocationActionResult {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  triggeredBy!: string;

  @Field(() => ID)
  fromQueueId!: string;

  @Field(() => ID)
  toQueueId!: string;

  @Field(() => [ID])
  affectedEmployeeIds!: string[];

  @Field(() => String)
  reason!: string;

  @Field(() => String)
  status!: string;

  /** Deterministic, real-metrics-citing object (never a real LLM/ML call) - `JSON` scalar, not a typed shape (varies by heuristic). Same `@Field(() => Object)` binding as root app's own `Policy.definition` (`src/modules/policy/graphql/policy.type.ts`), matching `JsonScalar`'s `@Scalar('JSON', () => Object)` registration. */
  @Field(() => Object, { nullable: true })
  aiRationale!: Record<string, unknown> | null;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date, { nullable: true })
  executedAt!: Date | null;
}

export function toReallocationActionResult(action: ReallocationAction): ReallocationActionResult {
  return {
    id: action.id,
    triggeredBy: action.triggeredBy,
    fromQueueId: action.fromQueueId,
    toQueueId: action.toQueueId,
    affectedEmployeeIds: action.affectedEmployeeIds,
    reason: action.reason,
    status: action.status,
    aiRationale: action.aiRationale,
    createdAt: action.createdAt,
    executedAt: action.executedAt,
  };
}
