import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { AttendanceExceptionType } from '../entities/attendance-record.entity';

/**
 * `GET /v1/attendance/exceptions` (Attendance & Leave Manager Views phase) -
 * the manager-facing exceptions report's list endpoint. `orgUnitId` and the
 * `dateFrom`/`dateTo` range are required (a tenant-wide, unbounded-range
 * dump is not this page's design - §3 of the phase prompt scopes it to "per
 * org unit and date range"). `orgUnitId` resolves to an `employeeId[]`
 * roster via gRPC, same RBAC-only scoping `ListLeaveRequestsQueryDto` uses.
 * `limit`/`offset` mirror the same `PaginationInput` convention.
 */
export class ListAttendanceExceptionsQueryDto {
  @IsUUID()
  orgUnitId!: string;

  @IsISO8601()
  dateFrom!: string;

  @IsISO8601()
  dateTo!: string;

  @IsOptional()
  @IsIn(Object.values(AttendanceExceptionType))
  exceptionType?: AttendanceExceptionType;

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
