import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { LeaveRequestStatus } from '../entities/leave-request.entity';

/**
 * `GET /v1/leave/requests` (Attendance & Leave Manager Views phase) - the
 * manager approval queue's list endpoint. `orgUnitId` is required (this is
 * a manager-scoped list, not a tenant-wide dump) and resolved to an
 * `employeeId[]` roster via `EmployeeGrpcClientService.getSchedulableRoster`
 * - RBAC-only scoping, same disclosed limitation as
 * `ComplianceReportController`'s `orgUnitScope` (see `PermissionsGuard`'s
 * own doc comment). `limit`/`offset` mirror the existing `PaginationInput`
 * convention (`src/modules/employee/dto/employee-filter.input.ts`) - plain
 * array response, no total count.
 */
export class ListLeaveRequestsQueryDto {
  @IsUUID()
  orgUnitId!: string;

  @IsOptional()
  @IsIn(Object.values(LeaveRequestStatus))
  status?: LeaveRequestStatus = LeaveRequestStatus.PENDING;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
