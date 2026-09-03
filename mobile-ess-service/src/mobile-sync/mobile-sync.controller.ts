import { Body, Controller, ForbiddenException, Post, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, RequestWithTokenClaims } from '../auth/access-token.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { EmployeeSessionVerificationService } from '../grpc/employee-session-verification.service';
import { MobileSyncBatchRequestDto } from './dto/mobile-sync-batch-request.dto';
import { MobileSyncActionResult, MobileSyncService } from './mobile-sync.service';

/**
 * `POST /v1/mobile/sync` (source spec §3.2). Always returns 200 with a
 * per-action results array, even when individual actions fail/conflict -
 * "a partial-failure batch... must return per-action results, not fail the
 * whole batch on one conflict" is the spec's own instruction, so this
 * controller never lets one action's error respond for the whole request.
 *
 * `deviceId` (the request body's other top-level field) is accepted but
 * not yet persisted/validated - `DeviceRegistration` doesn't exist until
 * Phase 5 (`registerDevice`); it's an opaque client-supplied string for
 * this phase, not FK-validated against anything.
 *
 * ADR-0150/ADR-0157: every action's `employeeId` is verified against the
 * caller's own session before any action runs - a batch mixing in another
 * employee's `employeeId` is rejected outright, not silently dropped.
 */
@Controller('v1/mobile')
@UseGuards(AccessTokenGuard, TenantTokenMatchGuard)
export class MobileSyncController {
  constructor(
    private readonly mobileSync: MobileSyncService,
    private readonly tenantContext: TenantContextService,
    private readonly employeeSession: EmployeeSessionVerificationService,
  ) {}

  @Post('sync')
  async sync(
    @Body() dto: MobileSyncBatchRequestDto,
    @Req() request: RequestWithTokenClaims,
  ): Promise<{ results: MobileSyncActionResult[] }> {
    const tenantId = this.tenantContext.requireTenantId();
    if (!request.tokenClaims) {
      throw new ForbiddenException('Access token claims are missing.');
    }
    const employeeIds = new Set(dto.actions.map((action) => action.employeeId));
    for (const employeeId of employeeIds) {
      await this.employeeSession.assertEmployeeIdMatchesSession(request.tokenClaims, employeeId);
    }
    const results = await this.mobileSync.syncBatch(tenantId, dto.actions);
    return { results };
  }
}
