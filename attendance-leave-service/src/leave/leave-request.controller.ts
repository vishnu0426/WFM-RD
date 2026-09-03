import { Body, Controller, Get, Headers, Post, Query, UseGuards } from '@nestjs/common';
import { LeaveRequestService } from './leave-request.service';
import { ListLeaveRequestsService } from './list-leave-requests.service';
import { RequestLeaveDto } from './dto/request-leave.dto';
import { SubmitBackdatedLeaveDto } from './dto/submit-backdated-leave.dto';
import { ListLeaveRequestsQueryDto } from './dto/list-leave-requests-query.dto';
import { LeaveRequest, LeaveRequestStatus } from './entities/leave-request.entity';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';

/**
 * §3.2: `POST /v1/leave/requests` - REST kept alongside the eventual
 * GraphQL `requestLeave` mutation (§3.1, not built this phase - see the
 * Phase 3 design doc). Tenant comes from `TenantContextMiddleware`'s
 * header-trust binding (already wired in Phase 1) - this is a dashboard/
 * app-client endpoint, not a server-to-server webhook, so it uses that
 * convention rather than the HMAC-guarded path §3.2's attendance endpoint
 * uses.
 *
 * `POST /v1/leave/backdated-requests` (Phase 6, §3.1/§5.1): a distinct
 * path, not `/v1/leave/requests` with an extra field - the same
 * separate-surface reasoning `SubmitBackdatedLeaveDto`'s doc comment gives
 * for the mutation itself applies equally to its REST mirror.
 *
 * `GET /v1/leave/requests` (Attendance & Leave Manager Views phase): the
 * manager approval queue's list endpoint - unlike the two `POST`s above,
 * this one is guarded (`AccessTokenGuard`/`PermissionsGuard`/
 * `TenantTokenMatchGuard`, `leave_request:read`), this service's first use
 * of `PermissionsGuard`. Only this handler carries the guard decorator -
 * `requestLeave`/`submitBackdatedLeave` are unchanged, unguarded, same
 * pre-existing posture this class's own doc comment already disclosed.
 */
@Controller('v1/leave')
export class LeaveRequestController {
  constructor(
    private readonly leaveRequestService: LeaveRequestService,
    private readonly listRequestsService: ListLeaveRequestsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('requests')
  async requestLeave(
    @Body() dto: RequestLeaveDto,
    @Headers('authorization') authHeader?: string,
  ): Promise<LeaveRequest> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.leaveRequestService.requestLeave(tenantId, dto, authHeader);
  }

  @Post('backdated-requests')
  async submitBackdatedLeave(
    @Body() dto: SubmitBackdatedLeaveDto,
    @Headers('authorization') authHeader?: string,
  ): Promise<LeaveRequest> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.leaveRequestService.submitBackdatedLeave(tenantId, dto, authHeader);
  }

  @Get('requests')
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('leave_request:read')
  async listRequests(@Query() query: ListLeaveRequestsQueryDto): Promise<LeaveRequest[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.listRequestsService.listForOrgUnit(
      tenantId,
      query.orgUnitId,
      query.status ?? LeaveRequestStatus.PENDING,
      query.limit ?? 50,
      query.offset ?? 0,
    );
  }
}
