import { Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ListEmployeeLeaveBalancesService } from './list-employee-leave-balances.service';
import { ProvisionLeaveBalanceService } from './provision-leave-balance.service';
import { LeaveBalanceSummaryDto, toLeaveBalanceSummary } from './dto/leave-balance-summary.dto';
import { ProvisionLeaveBalanceDto } from './dto/provision-leave-balance.dto';
import { LeaveBalance } from './entities/leave-balance.entity';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { AccessTokenGuard, RequestWithTokenClaims } from '../auth/access-token.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { EmployeeSessionVerificationService } from '../grpc/employee-session-verification.service';

/**
 * `GET /v1/leave/employees/{employeeId}/balances` (Module 11 Phase 7,
 * docs/adr/0156) - the mobile self-service Hours tab's leave-balance read
 * path, called directly by mobile-app (docs/adr/0146). Same guard +
 * session-verified `employeeId` posture as `EmployeeAttendanceRecordController`
 * (ADR-0150/ADR-0157).
 *
 * Attendance & Leave Manager Views phase: a manager approving a leave
 * request (or reviewing a backdated one) needs this same balance context
 * for an employee who isn't them - the self-match assertion below would
 * always 403 that caller. Rather than a second endpoint, a caller holding
 * `leave_request:read` bypasses the session-match check entirely (RBAC
 * only, same posture `PermissionsGuard`'s other new call sites use - not a
 * per-employee ownership check). Self-service callers without that
 * permission are unaffected: the original session-match path still runs.
 */
@Controller('v1/leave/employees')
@UseGuards(AccessTokenGuard, TenantTokenMatchGuard, PermissionsGuard)
export class EmployeeLeaveBalanceController {
  constructor(
    private readonly listService: ListEmployeeLeaveBalancesService,
    private readonly provisionService: ProvisionLeaveBalanceService,
    private readonly tenantContext: TenantContextService,
    private readonly employeeSession: EmployeeSessionVerificationService,
  ) {}

  @Get(':employeeId/balances')
  async listBalances(
    @Param('employeeId', new ParseUUIDPipe()) employeeId: string,
    @Req() request: RequestWithTokenClaims,
  ): Promise<LeaveBalanceSummaryDto[]> {
    const tenantId = this.tenantContext.requireTenantId();
    if (!request.tokenClaims) {
      throw new ForbiddenException('Access token claims are missing.');
    }
    const isManagerRead = request.tokenClaims.permissions.includes('leave_request:read');
    if (!isManagerRead) {
      await this.employeeSession.assertEmployeeIdMatchesSession(request.tokenClaims, employeeId);
    }
    const balances = await this.listService.listCurrentForEmployee(tenantId, employeeId);
    return balances.map(toLeaveBalanceSummary);
  }

  /**
   * Admin provisioning path — closes the gap `LeaveBalanceNotFoundError`'s
   * own doc comment previously disclosed as out of scope: until now the
   * only way to give an employee a balance was a manual SQL insert.
   * RBAC-gated (not session-locked like `listBalances` above) since this is
   * an HR-admin action on someone else's record, not a self-service read.
   */
  @Post(':employeeId/balances')
  @RequirePermissions('leave_balance:write')
  @HttpCode(HttpStatus.CREATED)
  async provisionBalance(
    @Param('employeeId', new ParseUUIDPipe()) employeeId: string,
    @Body() dto: ProvisionLeaveBalanceDto,
  ): Promise<LeaveBalance> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.provisionService.provision(tenantId, employeeId, dto);
  }
}
