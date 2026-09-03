import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { EmployeeGroupStatus } from '../entities/employee-group-status.enum';

registerEnumType(EmployeeGroupStatus, { name: 'EmployeeGroupStatus' });

@ObjectType('EmployeeGroup')
export class EmployeeGroupGraphQLType {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => ID, { nullable: true })
  organizationId!: string | null;

  @Field(() => ID, { nullable: true })
  parentGroupId!: string | null;

  @Field(() => EmployeeGroupStatus)
  status!: EmployeeGroupStatus;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}
