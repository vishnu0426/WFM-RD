import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsDateString, IsString, MinLength } from 'class-validator';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { HistoricalBackfillRunnerService } from './historical-backfill-runner.service';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { CurrentTokenClaims } from '../../auth/current-token-claims.decorator';
import { AccessTokenClaims } from '../../auth/access-token.guard';

export class StartHistoricalImportDto {
  @IsString()
  @MinLength(1)
  datasetKey!: string;

  @IsDateString()
  rangeStart!: string;

  @IsDateString()
  rangeEnd!: string;
}

function actorFromClaims(claims: AccessTokenClaims | undefined) {
  return { id: claims?.sub ?? null, type: 'user' as const };
}

/**
 * Tenant Admin Integration Management, WP5. Same guard trio/permission-risk
 * posture as `BatchSyncController`/`RelayController` - starting/cancelling
 * a real (once an adapter exists) external historical fetch is a
 * `:write`-tier operation; reading status is `:read`.
 */
@Controller('v1/integrations')
export class HistoricalImportController {
  constructor(
    private readonly runner: HistoricalBackfillRunnerService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('historical_import:write')
  @Post('connectors/:connectorId/historical-imports')
  async start(@Param('connectorId') connectorId: string, @Body() body: StartHistoricalImportDto, @CurrentTokenClaims() claims?: AccessTokenClaims) {
    const tenantId = this.tenantContext.requireTenantId();
    return this.runner.start(tenantId, connectorId, body.datasetKey, body.rangeStart, body.rangeEnd, actorFromClaims(claims));
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('historical_import:read')
  @Get('connectors/:connectorId/historical-imports')
  async listForConnector(@Param('connectorId') connectorId: string) {
    const tenantId = this.tenantContext.requireTenantId();
    return this.runner.listForConnector(tenantId, connectorId);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('historical_import:read')
  @Get('historical-imports/:jobId')
  async get(@Param('jobId') jobId: string) {
    const tenantId = this.tenantContext.requireTenantId();
    return this.runner.findJob(tenantId, jobId);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('historical_import:read')
  @Get('historical-imports/:jobId/chunks')
  async chunks(@Param('jobId') jobId: string) {
    const tenantId = this.tenantContext.requireTenantId();
    return this.runner.chunksForJob(tenantId, jobId);
  }

  /** Real landed rows (spec §38's Raw Data layer) - see `HistoricalRecord`'s own doc comment. */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('historical_import:read')
  @Get('historical-imports/:jobId/records')
  async records(@Param('jobId') jobId: string) {
    const tenantId = this.tenantContext.requireTenantId();
    return this.runner.recordsForJob(tenantId, jobId);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('historical_import:write')
  @Post('historical-imports/:jobId/resume')
  async resume(@Param('jobId') jobId: string, @CurrentTokenClaims() claims?: AccessTokenClaims) {
    const tenantId = this.tenantContext.requireTenantId();
    return this.runner.resume(tenantId, jobId, actorFromClaims(claims));
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('historical_import:write')
  @Post('historical-imports/:jobId/cancel')
  async cancel(@Param('jobId') jobId: string, @CurrentTokenClaims() claims?: AccessTokenClaims) {
    const tenantId = this.tenantContext.requireTenantId();
    return this.runner.cancel(tenantId, jobId, actorFromClaims(claims));
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('historical_import:write')
  @Post('historical-imports/chunks/:chunkId/retry')
  async retryChunk(@Param('chunkId') chunkId: string, @CurrentTokenClaims() claims?: AccessTokenClaims) {
    const tenantId = this.tenantContext.requireTenantId();
    return this.runner.retryChunk(tenantId, chunkId, actorFromClaims(claims));
  }
}
