import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { ListEmployeeAttendanceRecordsService } from './list-employee-attendance-records.service';
import { ListEmployeeAttendanceRecordsQueryDto } from './dto/list-employee-attendance-records-query.dto';
import { AttendanceRecord } from './entities/attendance-record.entity';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { AccessTokenGuard, RequestWithTokenClaims } from '../auth/access-token.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { EmployeeSessionVerificationService } from '../grpc/employee-session-verification.service';

/**
 * `GET /v1/attendance/employees/{employeeId}/records` (Module 11 Phase 7,
 * docs/adr/0156) - the mobile self-service Hours tab's read path, called
 * directly by mobile-app (docs/adr/0146), not routed through
 * mobile-ess-service. Returns raw `AttendanceRecord[]`, not a pre-summed
 * hours total: a server-computed total would bake in an unstated
 * day-boundary/attribution policy this module's own spec never defines
 * (e.g. how to attribute an overnight shift) - summation from
 * `clockInAt`/`clockOutAt` pairs is trivial client-side and stays
 * transparent about exactly what it's counting. A still-open record
 * (`clockOutAt: null`) is returned as-is - the caller decides how to
 * display "currently clocked in."
 *
 * ADR-0150/ADR-0157: now guarded (`AccessTokenGuard`/`TenantTokenMatchGuard`,
 * closing this endpoint's slice of ADR-0014's header-trust gap) and the
 * `employeeId` path param is verified against the caller's own session
 * before any data is returned - closing the carried-forward gap this
 * comment used to describe.
 */
@Controller('v1/attendance/employees')
@UseGuards(AccessTokenGuard, TenantTokenMatchGuard)
export class EmployeeAttendanceRecordController {
  constructor(
    private readonly listService: ListEmployeeAttendanceRecordsService,
    private readonly tenantContext: TenantContextService,
    private readonly employeeSession: EmployeeSessionVerificationService,
  ) {}

  @Get(':employeeId/records')
  async listRecords(
    @Param('employeeId', new ParseUUIDPipe()) employeeId: string,
    @Query() query: ListEmployeeAttendanceRecordsQueryDto,
    @Req() request: RequestWithTokenClaims,
  ): Promise<AttendanceRecord[]> {
    const tenantId = this.tenantContext.requireTenantId();
    if (!request.tokenClaims) {
      throw new ForbiddenException('Access token claims are missing.');
    }
    await this.employeeSession.assertEmployeeIdMatchesSession(request.tokenClaims, employeeId);
    return this.listService.listForEmployee(tenantId, employeeId, new Date(query.from), new Date(query.to));
  }
}
