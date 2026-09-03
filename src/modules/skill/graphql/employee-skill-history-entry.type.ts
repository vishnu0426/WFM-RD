import { Field, GraphQLISODateTime, ID, ObjectType } from '@nestjs/graphql';
import { ProficiencyLevel } from '../entities/proficiency-level.enum';

/**
 * GAP-07 fix (enterprise readiness audit, 2026-08-18): the SCD Type 2 read
 * surface for `EmployeeSkill` - same "backdated payroll dispute" motivation
 * `EmployeeHistoryEntryType`'s own doc comment names, now closed for skill
 * assignments too. Maps `EmployeeSkillHistory` (trigger-written, append-
 * only) directly. `ProficiencyLevel` is already registered as a GraphQL
 * enum by `employee-skill.type.ts` - not re-registered here.
 */
@ObjectType('EmployeeSkillHistoryEntry')
export class EmployeeSkillHistoryEntryType {
  @Field(() => ID)
  id!: string;

  @Field(() => GraphQLISODateTime)
  validFrom!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  validTo!: Date | null;

  @Field(() => ProficiencyLevel)
  proficiencyLevel!: ProficiencyLevel;

  @Field(() => String, { nullable: true })
  certifiedDate!: string | null;

  @Field(() => String, { nullable: true })
  expiryDate!: string | null;
}
