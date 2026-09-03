import { AttendanceIngestionEvent } from '../attendance/entities/attendance-ingestion-event.entity';
import { AttendanceRecord } from '../attendance/entities/attendance-record.entity';
import { AbsencePattern } from '../leave/entities/absence-pattern.entity';
import { LeaveBalance } from '../leave/entities/leave-balance.entity';
import { LeaveRequest } from '../leave/entities/leave-request.entity';
import { LeaveType } from '../leave/entities/leave-type.entity';
import { AccrualPolicy } from '../leave/entities/accrual-policy.entity';

/**
 * Single source of truth for "every entity in this service," consumed by
 * both the NestJS `TypeOrmModule` registration and the CLI `DataSource`
 * used for migrations - same convention as intraday-service's own
 * `src/database/entities.ts`.
 */
export const entities = [
  AttendanceRecord,
  LeaveType,
  LeaveBalance,
  LeaveRequest,
  AbsencePattern,
  AttendanceIngestionEvent,
  AccrualPolicy,
];

export { AttendanceRecord, LeaveType, LeaveBalance, LeaveRequest, AbsencePattern, AttendanceIngestionEvent, AccrualPolicy };
