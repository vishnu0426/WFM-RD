import { Field, ID, ObjectType, GraphQLISODateTime, registerEnumType } from '@nestjs/graphql';
import { AuditActorType } from '../entities/audit-actor-type.enum';

registerEnumType(AuditActorType, { name: 'AuditActorType' });

/** Phase 6 GraphQL BFF (ADR-0045) - read-only mirror of `core.audit_log`, matching `GET /v1/audit-log`'s REST shape. */
@ObjectType('AuditLogEntry')
export class AuditLogGraphQLType {
  @Field(() => ID)
  id!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => String, { nullable: true })
  actorId!: string | null;

  @Field(() => AuditActorType)
  actorType!: AuditActorType;

  @Field()
  action!: string;

  @Field()
  resourceType!: string;

  @Field(() => String, { nullable: true })
  resourceId!: string | null;

  @Field(() => Object, { nullable: true })
  beforeState!: Record<string, unknown> | null;

  @Field(() => Object, { nullable: true })
  afterState!: Record<string, unknown> | null;
}
