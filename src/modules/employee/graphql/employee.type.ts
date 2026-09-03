import { Field, Float, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { EmploymentType } from '../entities/employment-type.enum';
import { EmployeeStatus } from '../entities/employee-status.enum';
import { HomeAddressGraphQLType } from './home-address.type';

registerEnumType(EmploymentType, { name: 'EmploymentType' });
registerEnumType(EmployeeStatus, { name: 'EmployeeStatus' });

/**
 * §3.1's `Employee` type. Still no `skills` field - that needs the `Skill`
 * GraphQL type and its own resolver, Phase 4 scope (§8); adding a field
 * that always resolves empty would be exactly the kind of stub this
 * codebase's own conventions rule out.
 *
 * `orgUnit`/`manager`/`directReports` are deliberately not properties on
 * this class - they're contributed purely via `@ResolveField` on
 * `EmployeeResolver` (all fully real, `EmployeesRepository`/
 * `OrgUnitsRepository` already exist from Phase 1), the standard NestJS
 * code-first pattern for a computed/lazily-resolved field that has no
 * matching property on the underlying entity.
 */
@ObjectType('Employee')
export class EmployeeGraphQLType {
  @Field(() => ID)
  id!: string;

  @Field()
  employeeNumber!: string;

  @Field(() => EmploymentType)
  employmentType!: EmploymentType;

  @Field(() => EmployeeStatus)
  status!: EmployeeStatus;

  @Field(() => Float)
  contractHoursPerWeek!: string;

  @Field()
  hireDate!: string;

  @Field(() => String, { nullable: true })
  terminationDate!: string | null;

  @Field(() => String, { nullable: true })
  costCenter!: string | null;

  @Field(() => String, { nullable: true })
  userId!: string | null;

  @Field(() => String, { nullable: true })
  orgUnitId!: string;

  @Field(() => String, { nullable: true })
  managerEmployeeId!: string | null;

  // --- Personal ---
  @Field(() => String, { nullable: true })
  middleInitial!: string | null;

  @Field(() => String, { nullable: true })
  suffix!: string | null;

  @Field(() => String, { nullable: true })
  birthDate!: string | null;

  // --- Contact ---
  @Field(() => String, { nullable: true })
  email!: string | null;

  @Field(() => String, { nullable: true })
  desktopMessagingUsername!: string | null;

  @Field(() => String, { nullable: true })
  homePhone!: string | null;

  @Field(() => String, { nullable: true })
  workPhone!: string | null;

  @Field(() => String, { nullable: true })
  cellPhone!: string | null;

  @Field(() => HomeAddressGraphQLType, { nullable: true })
  homeAddress!: Record<string, string | null> | null;

  // --- Organizational relationships ---
  @Field()
  isSupervisor!: boolean;

  @Field()
  isTeamLead!: boolean;

  @Field(() => String, { nullable: true })
  teamLeadEmployeeId!: string | null;

  @Field(() => String, { nullable: true })
  jobTitle!: string | null;

  // --- Compensation ---
  // `taxId` is deliberately not a field on this type — see `taxIdLastFour`,
  // resolved via `@ResolveField` on `EmployeeResolver` using `maskTaxId()`.
  // The real value is only reachable via `GET /v1/employees/:id/tax-id`.

  @Field(() => Float, { nullable: true })
  wageAmount!: string | null;

  @Field(() => Int, { nullable: true })
  rank!: number | null;

  // --- Avatar ---
  @Field(() => String, { nullable: true })
  avatarUrl!: string | null;

  // agentId/extension/dataSource used to be plain fields here — moved to
  // the `dataSources` field (one row per ACD system), resolved via
  // `@ResolveField` same as `taxIdLastFour`/`workRules`/`interactions`
  // above, not declared here.
}
