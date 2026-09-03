import { Field, ID, ObjectType } from '@nestjs/graphql';

/** Phase 6 GraphQL BFF (ADR-0045) - read-only mirror of `core.roles`. `permissions` is a `@ResolveField` on `RoleResolver`. */
@ObjectType('Role')
export class RoleGraphQLType {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  tenantId!: string | null;

  @Field()
  name!: string;

  @Field()
  isSystemRole!: boolean;
}
