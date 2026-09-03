import { Field, GraphQLISODateTime, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { ErasureRequestStatus } from '../entities/erasure-request-status.enum';

registerEnumType(ErasureRequestStatus, { name: 'ErasureRequestStatus' });

/** §2.4/§8's `ErasureRequest` lifecycle type - no field here exposes what was anonymized (that's audit-log/metadata only, never re-surfaced through this API). */
@ObjectType('ErasureRequest')
export class ErasureRequestGraphQLType {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  employeeId!: string;

  @Field(() => ID)
  requestedBy!: string;

  @Field(() => GraphQLISODateTime)
  requestedAt!: Date;

  @Field()
  legalBasis!: string;

  @Field(() => ErasureRequestStatus)
  status!: ErasureRequestStatus;

  @Field(() => GraphQLISODateTime, { nullable: true })
  completedAt!: Date | null;
}
