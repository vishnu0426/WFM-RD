import { ArrayNotEmpty, IsArray, IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { ComplianceReportType } from '../../entities/compliance-report.entity';

const REPORT_TYPES = Object.values(ComplianceReportType);

/** `PUT /v1/compliance/retention-policies/{jurisdiction}`'s body - the jurisdiction itself is a path param, not repeated here. */
export class SetRetentionPolicyDto {
  @IsInt()
  @Min(1)
  retentionYears!: number;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(REPORT_TYPES, { each: true })
  appliesToReportTypes?: string[];
}
