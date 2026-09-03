import { Field, Float, GraphQLISODateTime, ObjectType, registerEnumType } from '@nestjs/graphql';
import { ProficiencyLevel } from '../entities/proficiency-level.enum';

registerEnumType(ProficiencyLevel, { name: 'ProficiencyLevel' });

/**
 * §3.1's `EmployeeSkill` type (`skill, proficiencyLevel, decayScore,
 * expiryDate`). `skill` is a `@ResolveField` on `EmployeeSkillResolver`
 * (skillId -> `Skill`), not a property here - same computed-field pattern
 * as `OrgUnit`/`Employee`'s cross-references.
 */
@ObjectType('EmployeeSkill')
export class EmployeeSkillGraphQLType {
  @Field(() => String)
  employeeId!: string;

  @Field(() => String)
  skillId!: string;

  @Field(() => ProficiencyLevel)
  proficiencyLevel!: ProficiencyLevel;

  @Field(() => String, { nullable: true })
  certifiedDate!: string | null;

  @Field(() => String, { nullable: true })
  expiryDate!: string | null;

  @Field(() => Float)
  decayScore!: string;

  @Field(() => GraphQLISODateTime, { nullable: true })
  lastScheduledOnSkillAt!: Date | null;
}
