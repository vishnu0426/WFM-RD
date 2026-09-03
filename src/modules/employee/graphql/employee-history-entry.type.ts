import { Field, GraphQLISODateTime, ID, ObjectType } from '@nestjs/graphql';
import { EmploymentType } from '../entities/employment-type.enum';
import { EmployeeStatus } from '../entities/employee-status.enum';

/**
 * §2.3's employee-side SCD Type 2 read surface (the same "backdated payroll
 * dispute" motivation named for `OrgUnitHistory` applies to `Employee`, not
 * just org units). Maps `EmployeeHistory` (Phase 1, trigger-written,
 * append-only) directly - see that entity's doc comment.
 */
@ObjectType('EmployeeHistoryEntry')
export class EmployeeHistoryEntryType {
  @Field(() => ID)
  id!: string;

  @Field(() => GraphQLISODateTime)
  validFrom!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  validTo!: Date | null;

  @Field(() => String)
  orgUnitId!: string;

  @Field()
  employeeNumber!: string;

  @Field(() => EmploymentType)
  employmentType!: EmploymentType;

  @Field()
  contractHoursPerWeek!: string;

  @Field(() => String, { nullable: true })
  costCenter!: string | null;

  @Field(() => String, { nullable: true })
  managerEmployeeId!: string | null;

  @Field(() => EmployeeStatus)
  status!: EmployeeStatus;
}
