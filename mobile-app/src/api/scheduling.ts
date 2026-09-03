import { apiGet } from './client';
import { ShiftAssignment } from './types';

/**
 * Calls scheduling-service's `GET /v1/scheduling/employees/{employeeId}/
 * shift-assignments` — the only existing endpoint that answers "what is this
 * employee scheduled to do" (added Module 05 Phase 2, docs/adr/0064). Only
 * assignments belonging to a published Schedule are ever returned.
 */
export async function getEmployeeShiftAssignments(params: {
  employeeId: string;
  tenantId: string;
  apiBaseUrl: string;
  from: Date;
  to: Date;
  signal?: AbortSignal;
}): Promise<ShiftAssignment[]> {
  return apiGet<ShiftAssignment[]>(
    `/v1/scheduling/employees/${params.employeeId}/shift-assignments`,
    { from: params.from.toISOString(), to: params.to.toISOString() },
    { tenantId: params.tenantId, apiBaseUrl: params.apiBaseUrl, signal: params.signal },
  );
}
