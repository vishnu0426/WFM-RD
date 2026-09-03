import { IsISO8601 } from 'class-validator';

/** `GET /v1/attendance/employees/{employeeId}/records` (Module 11 Phase 7,
 * docs/adr/0156). Mirrors `from`/`to` ISO8601 query param naming already
 * used by scheduling-service's own shift-assignments endpoint, which
 * `mobile-app` already calls with this exact shape. */
export class ListEmployeeAttendanceRecordsQueryDto {
  @IsISO8601()
  from!: string;

  @IsISO8601()
  to!: string;
}
