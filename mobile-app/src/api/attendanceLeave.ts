import { apiGet } from './client';
import { AttendanceRecordDto, LeaveBalanceSummary } from './types';

/**
 * `GET /v1/attendance/employees/{employeeId}/records` (docs/adr/0156) —
 * raw rows, not a pre-summed total; the Hours tab sums client-side.
 */
export async function getEmployeeAttendanceRecords(params: {
  employeeId: string;
  tenantId: string;
  apiBaseUrl: string;
  from: Date;
  to: Date;
  signal?: AbortSignal;
}): Promise<AttendanceRecordDto[]> {
  return apiGet<AttendanceRecordDto[]>(
    `/v1/attendance/employees/${params.employeeId}/records`,
    { from: params.from.toISOString(), to: params.to.toISOString() },
    { tenantId: params.tenantId, apiBaseUrl: params.apiBaseUrl, signal: params.signal },
  );
}

/** `GET /v1/leave/employees/{employeeId}/balances` (docs/adr/0156) —
 * current periods only, `availableDays` already computed server-side. */
export async function getEmployeeLeaveBalances(params: {
  employeeId: string;
  tenantId: string;
  apiBaseUrl: string;
  signal?: AbortSignal;
}): Promise<LeaveBalanceSummary[]> {
  return apiGet<LeaveBalanceSummary[]>(
    `/v1/leave/employees/${params.employeeId}/balances`,
    {},
    { tenantId: params.tenantId, apiBaseUrl: params.apiBaseUrl, signal: params.signal },
  );
}
