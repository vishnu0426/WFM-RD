import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { SkillStatus } from '../entities/skill-status.enum';

registerEnumType(SkillStatus, { name: 'SkillStatus' });

@ObjectType('Skill')
export class SkillGraphQLType {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  category!: string;

  @Field()
  requiresCertification!: boolean;

  @Field(() => Int, { nullable: true })
  certificationValidityDays!: number | null;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => SkillStatus)
  status!: SkillStatus;
}
