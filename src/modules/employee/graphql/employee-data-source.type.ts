import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType('EmployeeDataSource')
export class EmployeeDataSourceGraphQLType {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  employeeId!: string;

  @Field()
  dataSource!: string;

  @Field(() => String, { nullable: true })
  agentId!: string | null;

  @Field(() => String, { nullable: true })
  extension!: string | null;

  @Field()
  updatedAt!: Date;
}
