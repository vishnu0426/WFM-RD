import { IsDateString, IsUUID } from 'class-validator';

/** §3.1's `requestLeave` input, `date_range_start`/`date_range_end` shape (§3.2's `POST /v1/leave/requests` REST mirror). */
export class RequestLeaveDto {
  @IsUUID()
  employeeId!: string;

  @IsUUID()
  leaveTypeId!: string;

  /** `YYYY-MM-DD` - a `date` column, not a timestamp; no time-of-day component. */
  @IsDateString({ strict: true })
  dateRangeStart!: string;

  @IsDateString({ strict: true })
  dateRangeEnd!: string;
}
