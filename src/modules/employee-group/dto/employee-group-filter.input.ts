import { Field, InputType } from '@nestjs/graphql';
import { IsBoolean, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { EmployeeGroupStatus } from '../entities/employee-group-status.enum';

/** `employeeGroups(filter)` - same optional-filter-input shape as `EmployeeFilterInput`. */
@InputType()
export class EmployeeGroupFilterInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUUID()
  parentGroupId?: string;

  @Field(() => EmployeeGroupStatus, { nullable: true })
  @IsOptional()
  @IsEnum(EmployeeGroupStatus)
  status?: EmployeeGroupStatus;

  /**
   * User Management audit GAP-04: the reference's "Root Group" scope
   * concept has no dedicated column — a root group is just one with
   * `parentGroupId IS NULL`, which `parentGroupId` above can't express
   * (an exact-match filter, not an is-null one). Ignored if `parentGroupId`
   * is also set — a caller filtering to a specific parent's children isn't
   * asking for roots.
   */
  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  rootOnly?: boolean;
}
