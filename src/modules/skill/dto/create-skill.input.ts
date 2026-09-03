import { Field, InputType, Int } from '@nestjs/graphql';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { SkillStatus } from '../entities/skill-status.enum';

/**
 * §3.1 names no explicit `createSkill` mutation, but without one the skill
 * catalog `EmployeeSkill`/`updateEmployeeSkills` depend on has no API path
 * to populate at all beyond direct seed data - same gap-filling precedent
 * as `createOrgUnit` (Phase 2, ADR "OrgUnit CRUD" assumption) and
 * `createEmployee`'s sibling mutations (Phase 3, ADR-0016).
 */
@InputType()
export class CreateSkillInput {
  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  category!: string;

  @Field({ defaultValue: false })
  @IsBoolean()
  requiresCertification!: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @ValidateIf((o: CreateSkillInput) => o.requiresCertification)
  @IsInt()
  @Min(1)
  @Max(3650)
  certificationValidityDays?: number;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  description?: string | null;

  @Field(() => SkillStatus, { nullable: true })
  @IsOptional()
  @IsEnum(SkillStatus)
  status?: SkillStatus;
}
