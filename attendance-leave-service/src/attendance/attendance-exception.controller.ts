import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ListAttendanceExceptionsService } from './list-attendance-exceptions.service';
import { ListAttendanceExceptionsQueryDto } from './dto/list-attendance-exceptions-query.dto';
import { AttendanceRecord } from './entities/attendance-record.entity';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';

/**
 * `GET /v1/attendance/exceptions` (Attendance & Leave Manager Views phase) -
 * the manager-facing, read-only exceptions report. Unlike
 * `EmployeeAttendanceRecordController` (self-service, session-locked to one
 * employee), this is a manager-scoped, multi-employee list, gated on
 * `attendance_record:read` (a new permission resource - see
 * `src/database/seeds/run-seed.ts`'s `RESOURCES` array) rather than a
 * session match.
 */
@Controller('v1/attendance')
@UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
export class AttendanceExceptionController {
  constructor(
    private readonly listService: ListAttendanceExceptionsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('exceptions')
  @RequirePermissions('attendance_record:read')
  async listExceptions(@Query() query: ListAttendanceExceptionsQueryDto): Promise<AttendanceRecord[]> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.listService.listForOrgUnit(
      tenantId,
      query.orgUnitId,
      new Date(query.dateFrom),
      new Date(query.dateTo),
      query.exceptionType,
      query.limit ?? 50,
      query.offset ?? 0,
    );
  }
}
