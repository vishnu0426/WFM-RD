import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { AssigneeType } from '../entities/assignee-type.enum';

@ObjectType('WorkRuleAssignment')
export class WorkRuleAssignmentGraphQLType {
  @Field(() => ID)
  workRuleId!: string;

  @Field(() => AssigneeType)
  assigneeType!: AssigneeType;

  @Field(() => ID)
  assigneeId!: string;

  @Field()
  assignedAt!: Date;

  @Field(() => Int)
  priority!: number;

  @Field(() => String, { nullable: true })
  effectiveFrom!: string | null;

  @Field(() => String, { nullable: true })
  effectiveTo!: string | null;
}
