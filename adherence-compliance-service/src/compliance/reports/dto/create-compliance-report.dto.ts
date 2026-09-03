import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ComplianceReportType } from '../../entities/compliance-report.entity';

/**
 * §3.2's `POST /v1/compliance/reports` body. REST-only, plain
 * `class-validator` DTO (no `@InputType`) - unlike `CreateComplianceRuleInput`,
 * this endpoint has a literal REST contract and no GraphQL equivalent
 * (docs/adr/0105).
 *
 * `generatedBy` is caller-supplied, not inferred from any auth context -
 * this module has no RBAC/identity integration at all (§8's own non-goal),
 * the same posture every other caller-supplied actor id in this platform
 * takes absent one.
 */
export class CreateComplianceReportDto {
  @IsEnum(ComplianceReportType)
  reportType!: ComplianceReportType;

  @IsDateString({ strict: true })
  dateRangeStart!: string;

  @IsDateString({ strict: true })
  dateRangeEnd!: string;

  @IsOptional()
  @IsUUID()
  orgUnitScope?: string;

  @IsUUID()
  generatedBy!: string;
}
