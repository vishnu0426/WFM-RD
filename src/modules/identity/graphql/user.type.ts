import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { UserStatus } from '../entities/user-status.enum';

registerEnumType(UserStatus, { name: 'UserStatus' });

/** Phase 6 GraphQL BFF (ADR-0045) - read-only mirror of `core.users`. `roles` is a `@ResolveField` on `UserResolver`. */
@ObjectType('User')
export class UserGraphQLType {
  @Field(() => ID)
  id!: string;

  @Field()
  email!: string;

  @Field(() => UserStatus)
  status!: UserStatus;

  @Field()
  mfaEnabled!: boolean;

  @Field(() => String, { nullable: true })
  givenName!: string | null;

  @Field(() => String, { nullable: true })
  familyName!: string | null;

  @Field(() => String, { nullable: true })
  username!: string | null;
}
