import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType('HomeAddress')
export class HomeAddressGraphQLType {
  @Field(() => String, { nullable: true })
  street1!: string | null;

  @Field(() => String, { nullable: true })
  street2!: string | null;

  @Field(() => String, { nullable: true })
  city!: string | null;

  @Field(() => String, { nullable: true })
  region!: string | null;

  @Field(() => String, { nullable: true })
  postalCode!: string | null;

  @Field(() => String, { nullable: true })
  country!: string | null;
}
