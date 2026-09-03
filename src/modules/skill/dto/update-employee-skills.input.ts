import { Field, InputType } from '@nestjs/graphql';
import { IsArray, IsDateString, IsEnum, IsOptional, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ProficiencyLevel } from '../entities/proficiency-level.enum';

@InputType()
export class EmployeeSkillAssignmentInput {
  @Field(() => String)
  @IsUUID()
  skillId!: string;

  @Field(() => ProficiencyLevel)
  @IsEnum(ProficiencyLevel)
  proficiencyLevel!: ProficiencyLevel;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsDateString()
  certifiedDate?: string;
}

/**
 * §3.1's `updateEmployeeSkills` mutation - a bulk upsert (add new
 * assignments, update `proficiencyLevel`/`certifiedDate` on existing ones)
 * rather than one mutation per skill, matching how a real caller (an HR
 * admin editing an employee's whole skill set in one form submission) would
 * actually use it. `expiryDate`/`decayScore` are never settable here -
 * both are trigger/job-computed (Phase 1's `org.fn_employee_skill_set_expiry`,
 * this phase's nightly decay job).
 */
@InputType()
export class UpdateEmployeeSkillsInput {
  @Field(() => String)
  @IsUUID()
  employeeId!: string;

  @Field(() => [EmployeeSkillAssignmentInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EmployeeSkillAssignmentInput)
  skills!: EmployeeSkillAssignmentInput[];
}
