import { Field, InputType, registerEnumType } from '@nestjs/graphql';
import { IsEnum, IsString, IsUUID, MinLength } from 'class-validator';
import { InteractionType } from '../entities/interaction-type.enum';

registerEnumType(InteractionType, { name: 'InteractionType' });

@InputType()
export class CreateEmployeeInteractionInput {
  @Field(() => String)
  @IsUUID()
  employeeId!: string;

  @Field(() => InteractionType)
  @IsEnum(InteractionType)
  interactionType!: InteractionType;

  @Field()
  @IsString()
  @MinLength(1)
  body!: string;
}
