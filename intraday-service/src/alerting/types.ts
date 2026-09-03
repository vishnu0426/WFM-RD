import { Field, ID, ObjectType } from '@nestjs/graphql';

/** §2.1/§5a - co-located with the domain, same convention as `src/live-state/types.ts`. */
@ObjectType('Alert')
export class AlertResult {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  alertType!: string;

  @Field(() => String)
  severity!: string;

  /** Always `null` today - design doc assumption 5. */
  @Field(() => ID, { nullable: true })
  orgUnitId!: string | null;

  @Field(() => ID, { nullable: true })
  queueId!: string | null;

  @Field(() => String)
  status!: string;

  @Field(() => ID)
  dedupGroupId!: string;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  lastTriggeredAt!: Date;

  @Field(() => Date, { nullable: true })
  escalatedAt!: Date | null;

  @Field(() => ID, { nullable: true })
  acknowledgedBy!: string | null;

  @Field(() => Date, { nullable: true })
  acknowledgedAt!: Date | null;

  @Field(() => Date, { nullable: true })
  resolvedAt!: Date | null;
}
