import { Field, ID, ObjectType } from '@nestjs/graphql';
import { InteractionType } from '../entities/interaction-type.enum';

@ObjectType('EmployeeInteraction')
export class EmployeeInteractionGraphQLType {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  employeeId!: string;

  @Field(() => InteractionType)
  interactionType!: InteractionType;

  @Field()
  body!: string;

  @Field(() => String, { nullable: true })
  createdBy!: string | null;

  @Field()
  createdAt!: Date;
}
