import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { PermissionAction } from '../entities/permission-action.enum';

registerEnumType(PermissionAction, { name: 'PermissionAction' });

/** Phase 6 GraphQL BFF (ADR-0045) - read-only mirror of the global `core.permissions` catalog. */
@ObjectType('Permission')
export class PermissionGraphQLType {
  @Field(() => ID)
  id!: string;

  @Field()
  resource!: string;

  @Field(() => PermissionAction)
  action!: PermissionAction;
}
