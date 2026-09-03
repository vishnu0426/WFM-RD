import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType('FeatureFlag')
export class FeatureFlagGraphQLType {
  @Field()
  flagKey!: string;

  @Field()
  enabled!: boolean;
}
