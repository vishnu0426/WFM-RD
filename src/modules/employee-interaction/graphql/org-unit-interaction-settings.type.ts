import { Field, Float, ID, ObjectType } from '@nestjs/graphql';

@ObjectType('OrgUnitInteractionSettings')
export class OrgUnitInteractionSettingsGraphQLType {
  @Field(() => ID)
  orgUnitId!: string;

  /** True when this row is a real, resolved settings source — false when it's a synthetic platform-default fallback (no row exists anywhere up the tree). */
  @Field()
  isConfigured!: boolean;

  /** The org unit this value was actually resolved from — may differ from `orgUnitId` when inherited from an ancestor. */
  @Field(() => ID, { nullable: true })
  resolvedFromOrgUnitId!: string | null;

  @Field()
  inheritFromParent!: boolean;

  @Field()
  systemDefined!: boolean;

  @Field(() => Float, { nullable: true })
  audioRecordingPercentage!: string | null;

  @Field(() => Float, { nullable: true })
  videoRecordingPercentage!: string | null;

  @Field(() => Float, { nullable: true })
  screenRecordingPercentage!: string | null;

  @Field(() => String, { nullable: true })
  inboxUrl!: string | null;

  @Field(() => String, { nullable: true })
  conditionalCustomDataJson!: string | null;

  @Field(() => String, { nullable: true })
  updatedAt!: string | null;
}
