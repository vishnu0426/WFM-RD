import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import { AdherenceScore } from './entities/adherence-score.entity';

/**
 * Module 11 Phase 7 (docs/adr/0156) - co-located with the domain, same
 * convention as `compliance/types.ts`. `computedAt` is surfaced
 * explicitly so a caller can show "as of HH:MM" - the freshness signal
 * here, playing the same role `agentLiveState.dataFreshness` plays for
 * intraday-service's live snapshot, since this table has no status field
 * of its own.
 */
@ObjectType('AdherenceScore')
export class AdherenceScoreResult {
  @Field(() => ID)
  employeeId!: string;

  @Field(() => Date)
  periodStart!: Date;

  @Field(() => Date)
  periodEnd!: Date;

  @Field(() => Float)
  adherencePct!: number;

  @Field(() => Int)
  majorDeviationCount!: number;

  @Field(() => Int)
  adherentSeconds!: number;

  @Field(() => Int)
  totalScheduledSeconds!: number;

  @Field(() => Date)
  computedAt!: Date;
}

export function toAdherenceScoreResult(score: AdherenceScore): AdherenceScoreResult {
  return {
    employeeId: score.employeeId,
    periodStart: score.periodStart,
    periodEnd: score.periodEnd,
    adherencePct: Number(score.adherencePct),
    majorDeviationCount: score.majorDeviationCount,
    adherentSeconds: score.adherentSeconds,
    totalScheduledSeconds: score.totalScheduledSeconds,
    computedAt: score.computedAt,
  };
}
