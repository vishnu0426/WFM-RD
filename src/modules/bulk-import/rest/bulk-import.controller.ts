import { Body, Controller, Get, HttpCode, HttpStatus, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { BulkImportService } from '../services/bulk-import.service';
import { BulkImportRequestDto } from '../dto/bulk-import-record.dto';
import { BulkImportJob } from '../entities/bulk-import-job.entity';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/**
 * §3.2's `POST /v1/employees/bulk-import` (async job pattern) and `GET /v1/jobs/{job_id}`.
 * Gated for the first time here (frontend Phase 1 prerequisite): this is the
 * highest-blast-radius write surface in Module 02 (can touch thousands of
 * employee records in one call) and had no guard at all. `employee:write`
 * for both a dry-run and a committing import - the dry-run/commit
 * distinction itself is a `dryRun` flag on the request body, not a
 * different permission (see `BulkImportRequestDto`).
 */
@Controller('v1')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class BulkImportController {
  constructor(private readonly bulkImportService: BulkImportService) {}

  @Post('employees/bulk-import')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions('employee:write')
  async bulkImport(
    @Body() request: BulkImportRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<BulkImportJob> {
    return this.bulkImportService.startImport(request, idempotencyKey ?? null);
  }

  @Get('jobs/:id')
  @RequirePermissions('employee:read')
  async getJob(@Param('id') id: string): Promise<BulkImportJob> {
    return this.bulkImportService.findJob(id);
  }
}
