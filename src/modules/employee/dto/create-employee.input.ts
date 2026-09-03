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
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EmploymentType } from '../entities/employment-type.enum';
import { HomeAddressInput } from './home-address.input';

@InputType()
export class CreateEmployeeInput {
  /** §2.2 rule 2: nullable by design - headcount-only employees have no login access. */
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUUID()
  userId?: string | null;

  @Field(() => String)
  @IsUUID()
  orgUnitId!: string;

  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  employeeNumber!: string;

  @Field(() => EmploymentType)
  @IsEnum(EmploymentType)
  employmentType!: EmploymentType;

  @Field(() => Float)
  @Min(0)
  @Max(168)
  contractHoursPerWeek!: number;

  @Field()
  @IsDateString()
  hireDate!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  costCenter?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUUID()
  managerEmployeeId?: string | null;

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
  // agentId/extension/dataSource used to live here as single scalar fields —
  // moved to the `EmployeeDataSource` child table (`addEmployeeDataSource`
  // mutation) so an employee can hold one Agent ID/Extension per ACD system
  // (AACC, CM, SR_DS, WFM_DS, ...) instead of exactly one overall. Not
  // settable at creation time for the same reason avatarUrl isn't: a child
  // row needs a real employeeId first.
}
