import { Field, Float, InputType, Int } from '@nestjs/graphql';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EmploymentType } from '../entities/employment-type.enum';
import { EmployeeStatus } from '../entities/employee-status.enum';
import { HomeAddressInput } from './home-address.input';

/**
 * Deliberately excludes `orgUnitId`/`managerEmployeeId` - §3.1 names
 * `transferEmployee` as the dedicated mutation for that (see
 * `EmployeesService.transfer`); folding it into a generic update would blur
 * the "transfer" flow §8's Phase 3 scope explicitly calls out as its own
 * thing. Termination is `status: TERMINATED` (+ optional `terminationDate`,
 * defaulted to today if omitted - see `EmployeesService.update`), not a
 * separate mutation - §3.1 names no `terminateEmployee` mutation, and the
 * schema already models termination as a status/column pair on the same row.
 */
@InputType()
export class UpdateEmployeeInput {
  @Field(() => EmploymentType, { nullable: true })
  @IsOptional()
  @IsEnum(EmploymentType)
  employmentType?: EmploymentType;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(168)
  contractHoursPerWeek?: number;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  costCenter?: string | null;

  @Field(() => EmployeeStatus, { nullable: true })
  @IsOptional()
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsDateString()
  terminationDate?: string;

  /**
   * Closes ADR-0150's `userId -> Employee` gap - the link/unlink path a
   * headcount-only employee (created with `userId: null`,
   * `CreateEmployeeInput`'s own already-existing field) needed but never
   * had. `null` explicitly unlinks; `undefined` (the field simply
   * omitted) leaves the existing value untouched, same convention every
   * other optional field on this input already uses. Admin-only -
   * `EmployeeResolver`'s own `@RequirePermissions('employee:write')`
   * gates this the same as every other field here.
   */
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUUID()
  userId?: string | null;

  /**
   * GAP-07 fix (enterprise readiness audit, 2026-08-18): when supplied, the
   * resulting `EmployeeHistory` version is dated as of this timestamp
   * instead of "now" - a backdated correction or a future-dated scheduled
   * change, not just an as-of-today edit. Omitted = effective now
   * (unchanged default behavior).
   */
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsDateString()
  effectiveDate?: string;

  // --- Personal ---
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  middleInitial?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  suffix?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsDateString()
  birthDate?: string | null;

  // --- Contact ---
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  desktopMessagingUsername?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  homePhone?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  workPhone?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  cellPhone?: string | null;

  @Field(() => HomeAddressInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => HomeAddressInput)
  homeAddress?: HomeAddressInput | null;

  // --- Organizational relationships ---
  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isSupervisor?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isTeamLead?: boolean;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUUID()
  teamLeadEmployeeId?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  jobTitle?: string | null;

  // --- Compensation ---
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  taxId?: string | null;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  wageAmount?: number | null;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  rank?: number | null;

  // --- Avatar / ACD ---
  // `avatarUrl` is deliberately not settable here — only
  // `POST /v1/employees/:id/avatar` writes it, after validating the upload.
  //
  // agentId/extension/dataSource moved to the `EmployeeDataSource` child
  // table (`addEmployeeDataSource`/`updateEmployeeDataSource`/
  // `removeEmployeeDataSource` mutations) — an employee can now hold one
  // Agent ID/Extension per ACD system instead of exactly one overall.
}
