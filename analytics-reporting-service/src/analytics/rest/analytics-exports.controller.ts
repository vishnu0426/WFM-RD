import { Body, Controller, Get, Headers, Param, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AnalyticsExportService } from '../analytics-export.service';
import { MetricQueryFilter } from '../metric-query-engine.service';
import { AccessTokenGuard, AccessTokenClaims } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { CurrentTokenClaims } from '../../auth/current-token-claims.decorator';

class CreateExportDto {
  @IsString()
  @MaxLength(200)
  metricName!: string;

  @IsOptional()
  @IsObject()
  filter?: Record<string, unknown>;
}

/**
 * §4.2/§1: `POST /v1/analytics/exports` + `GET /v1/analytics/exports/{id}/download`,
 * plus a `GET /v1/analytics/exports/{id}` poll-for-status endpoint (own
 * copy of Module 08's `GET :id` pattern - a caller needs to know an export
 * is `completed` before the download endpoint has anything to redirect
 * to). `Idempotency-Key` is a real header, read here and passed through to
 * `AnalyticsExportService` - see that service's own doc comment for why
 * this module implements it itself rather than reusing either of this
 * platform's two existing idempotency mechanisms.
 *
 * ADR-0164: real-RBAC-gated - `analytics_export:write` for the one write
 * (`requestExport`), `analytics_export:read` for the three reads. Actor
 * identity now comes from the verified JWT's own `sub` claim
 * (`@CurrentTokenClaims()`), not the previously-trusted `X-Actor-Id`
 * header - `getExport`/`getDownloadUrl`/`listExports` all scope to
 * `requestedBy === actorId`, so this closes the same spoofing gap
 * `DashboardResolver` closed for dashboard ownership.
 */
@Controller('v1/analytics/exports')
export class AnalyticsExportsController {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly exportService: AnalyticsExportService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('analytics_export:write')
  @Post()
  async requestExport(
    @Body() body: CreateExportDto,
    @CurrentTokenClaims() claims: AccessTokenClaims,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const tenantId = this.tenantContext.requireTenantId();
    return this.exportService.requestExport(tenantId, claims.sub as string, {
      metricName: body.metricName,
      filter: parseFilter(body.filter),
      idempotencyKey,
    });
  }

  /** §5's export history list - added alongside the frontend's exports page, which needs to show every past export request, not just one already-known id. */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('analytics_export:read')
  @Get()
  async listExports(@CurrentTokenClaims() claims: AccessTokenClaims) {
    const tenantId = this.tenantContext.requireTenantId();
    return this.exportService.listExports(tenantId, claims.sub as string);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('analytics_export:read')
  @Get(':id')
  async getExport(@Param('id') id: string, @CurrentTokenClaims() claims: AccessTokenClaims) {
    const tenantId = this.tenantContext.requireTenantId();
    return this.exportService.getExport(tenantId, claims.sub as string, id);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('analytics_export:read')
  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @CurrentTokenClaims() claims: AccessTokenClaims,
    @Res() res: Response,
  ): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    const url = await this.exportService.getDownloadUrl(tenantId, claims.sub as string, id);
    res.redirect(url);
  }
}

/** `periodStart`/`periodEnd` arrive as ISO date strings over JSON - converted to real `Date`s here, once, rather than trusting every downstream reader to know a REST body's dates are still strings. */
function parseFilter(filter?: Record<string, unknown>): MetricQueryFilter {
  if (!filter) {
    return {};
  }
  return {
    ...filter,
    periodStart: filter.periodStart ? new Date(filter.periodStart as string) : undefined,
    periodEnd: filter.periodEnd ? new Date(filter.periodEnd as string) : undefined,
  };
}
