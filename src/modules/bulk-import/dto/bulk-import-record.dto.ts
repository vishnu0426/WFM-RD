import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { EmploymentType } from '../../employee/entities/employment-type.enum';

/** One HRIS record - REST-only (§3.2), so plain `class-validator` DTOs, no GraphQL `InputType`. */
export class BulkImportRecordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  employeeNumber!: string;

  @IsUUID()
  orgUnitId!: string;

  @IsEnum(EmploymentType)
  employmentType!: EmploymentType;

  @IsNumber()
  @Min(0)
  @Max(168)
  contractHoursPerWeek!: number;

  @IsDateString()
  hireDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  costCenter?: string;

  @IsOptional()
  @IsUUID()
  managerEmployeeId?: string;
}

export class BulkImportRequestDto {
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkImportRecordDto)
  records!: BulkImportRecordDto[];
}
