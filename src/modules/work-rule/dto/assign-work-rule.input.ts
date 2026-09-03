import { Field, Int, InputType, registerEnumType } from '@nestjs/graphql';
import { IsDateString, IsEnum, IsInt, IsOptional, IsUUID } from 'class-validator';
import { AssigneeType } from '../entities/assignee-type.enum';

registerEnumType(AssigneeType, { name: 'WorkRuleAssigneeType' });

@InputType()
export class AssignWorkRuleInput {
  @Field(() => String)
  @IsUUID()
  workRuleId!: string;

  @Field(() => AssigneeType)
  @IsEnum(AssigneeType)
  assigneeType!: AssigneeType;

  @Field(() => String)
  @IsUUID()
  assigneeId!: string;

  /** Higher wins when an employee is covered by more than one binding (GAP-05). Ignored by unassign. */
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  priority?: number;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsDateString()
  effectiveTo?: string | null;
}
