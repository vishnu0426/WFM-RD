import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ComplianceReportService } from './compliance-report.service';
import { CreateComplianceReportDto } from './dto/create-compliance-report.dto';
import { SetLegalHoldDto } from './dto/set-legal-hold.dto';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { ComplianceReport } from '../entities/compliance-report.entity';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';

export interface ComplianceReportResponse {
  id: string;
  reportType: string;
  status: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  orgUnitScope: string | null;
  fileUri: string | null;
  downloadUrl: string | null;
  legalHold: boolean;
  retentionExpiresAt: Date;
  generatedAt: Date;
  generatedBy: string;
}

// retentionExpiresAt was computed and stored on every row (§5b: "not left
// null, not assumed indefinite") but never actually left the entity - no
// caller of this response type could ever see it. Added alongside the
// frontend's own report history/retention pages, which need it to show
// "expires on" and to build a proactive "expiring soon" list at all.
function toResponse(report: ComplianceReport, downloadUrl: string | null): ComplianceReportResponse {
  return {
    id: report.id,
    reportType: report.reportType,
    status: report.status,
    dateRangeStart: report.dateRangeStart,
    dateRangeEnd: report.dateRangeEnd,
    orgUnitScope: report.orgUnitScope,
    fileUri: report.fileUri,
    downloadUrl,
    legalHold: report.legalHold,
    retentionExpiresAt: report.retentionExpiresAt,
    generatedAt: report.generatedAt,
    generatedBy: report.generatedBy,
  };
}

/**
 * §3.2's `POST /v1/compliance/reports` - explicitly async, returns the
 * `pending` row immediately (docs/adr/0105: in-process, not a separate
 * worker). `GET /v1/compliance/reports/{id}` is this endpoint's own poll-
 * for-result counterpart, same "submit, then GET by id" shape every other
 * async job surface in this platform uses (scheduling-service's
 * `GET /v1/scheduling/jobs/{jobId}`). `PATCH .../{id}/legal-hold`
 * (docs/adr/0106) is the retention lifecycle job's own write path -
 * without it `legal_hold` could never actually become `true`.
 *
 * ADR-0161: gated with the `compliance_report` resource -
 * `POST`/`GET` use `:write`/`:read` matching every other resource in this
 * platform; `PATCH .../legal-hold` uses `:approve` rather than `:write` -
 * placing a legal hold is a materially different, higher-stakes action
 * from generating a report (the same `role:delete`/`ai_recommendation:approve`
 * precedent for giving one write-adjacent-but-distinct action its own
 * permission rather than folding it into `:write`).
 */
@Controller('v1/compliance/reports')
export class ComplianceReportController {
  constructor(
    private readonly complianceReportService: ComplianceReportService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('compliance_report:write')
  @Post()
  async requestReport(@Body() body: CreateComplianceReportDto): Promise<ComplianceReportResponse> {
    const tenantId = this.tenantContext.requireTenantId();
    const report = await this.complianceReportService.requestReport(tenantId, body);
    return toResponse(report, null);
  }

  /**
   * §4's report history list - added alongside the frontend's report-builder
   * page, which needs to show every past report (not just one already-known
   * id) plus each one's retention/legal-hold state at a glance. No download
   * URL per row (§3.2's own presigned-URL generation stays a per-report,
   * on-demand `GET .../{id}` call - resolving one for every row here would
   * mean N presign calls per page load for links most rows will never use).
   */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('compliance_report:read')
  @Get()
  async listReports(): Promise<ComplianceReportResponse[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const reports = await this.complianceReportService.listReports(tenantId);
    return reports.map((report) => toResponse(report, null));
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('compliance_report:read')
  @Get(':id')
  async getReport(@Param('id') id: string): Promise<ComplianceReportResponse> {
    const tenantId = this.tenantContext.requireTenantId();
    const { report, downloadUrl } = await this.complianceReportService.getReport(tenantId, id);
    return toResponse(report, downloadUrl);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('compliance_report:approve')
  @Patch(':id/legal-hold')
  async setLegalHold(@Param('id') id: string, @Body() body: SetLegalHoldDto): Promise<ComplianceReportResponse> {
    const tenantId = this.tenantContext.requireTenantId();
    const report = await this.complianceReportService.setLegalHold(tenantId, id, body.legalHold);
    return toResponse(report, null);
  }
}
