import { Field, InputType, Int } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { EmployeeStatus } from '../entities/employee-status.enum';
import { EmploymentType } from '../entities/employment-type.enum';

/**
 * §3.1 `employees(filter, pagination)`. No org-unit-subtree/role-based
 * scoping is applied automatically here - that's the ABAC gap ADR-0014
 * already flags (ADR-0014's "not implemented" note applies to this query
 * too, not just `orgHierarchy`). `orgUnitId` is an explicit, caller-supplied
 * filter, not derived from the caller's own role/scope.
 */
@InputType()
export class EmployeeFilterInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUUID()
  orgUnitId?: string;

  @Field(() => EmployeeStatus, { nullable: true })
  @IsOptional()
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;

  @Field(() => EmploymentType, { nullable: true })
  @IsOptional()
  @IsEnum(EmploymentType)
  employmentType?: EmploymentType;
}

@InputType()
export class PaginationInput {
  @Field(() => Int, { nullable: true, defaultValue: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @Field(() => Int, { nullable: true, defaultValue: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}
