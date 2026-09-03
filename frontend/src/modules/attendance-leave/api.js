/* Attendance & Leave (Module 06, :8300) client. Real REST wiring for the
   User Management Time Off screen — LeaveType CRUD + LeaveRequest
   create/list/decision + per-employee balances. Reuses core/api.js's
   generic apiFetch (via Api.leaveApi), which already attaches both the
   Bearer token and the x-tenant-id header this service's
   TenantContextMiddleware requires. */
import { Api } from '../../core/api.js';

export async function healthCheck() {
  return Api.leaveApi('/healthz');
}

/* ---------- Leave Types ---------- */
export const listLeaveTypes = () => Api.leaveApi('/v1/leave-types');
export const createLeaveType = (body) => Api.leaveApi('/v1/leave-types', { method: 'POST', body });
export const updateLeaveType = (id, body) => Api.leaveApi(`/v1/leave-types/${id}`, { method: 'PATCH', body });
export const deleteLeaveType = (id) => Api.leaveApi(`/v1/leave-types/${id}`, { method: 'DELETE' });

/* ---------- Leave Requests ---------- */
/** `GET /v1/leave/requests` requires `orgUnitId` — this service has no tenant-wide list endpoint. */
export const listLeaveRequests = (orgUnitId, status) => {
  const q = new URLSearchParams({ orgUnitId });
  if (status) q.set('status', status);
  return Api.leaveApi(`/v1/leave/requests?${q.toString()}`);
};
export const createLeaveRequest = (body) => Api.leaveApi('/v1/leave/requests', { method: 'POST', body });
export const decideLeaveRequest = (id, body) => Api.leaveApi(`/v1/leave/requests/${id}/decision`, { method: 'POST', body });

/* ---------- Accrual Policies (User Management audit GAP-02) ---------- */
export const listAccrualPolicies = () => Api.leaveApi('/v1/accrual-policies');
export const createAccrualPolicy = (body) => Api.leaveApi('/v1/accrual-policies', { method: 'POST', body });
export const updateAccrualPolicy = (id, body) => Api.leaveApi(`/v1/accrual-policies/${id}`, { method: 'PATCH', body });
export const deleteAccrualPolicy = (id) => Api.leaveApi(`/v1/accrual-policies/${id}`, { method: 'DELETE' });

/* ---------- Balances ---------- */
export const getEmployeeLeaveBalances = (employeeId) => Api.leaveApi(`/v1/leave/employees/${employeeId}/balances`);
/** `leave_balance:write`-gated admin provisioning path — the only way to give an employee a balance, short of a direct SQL insert. */
export const provisionLeaveBalance = (employeeId, body) => Api.leaveApi(`/v1/leave/employees/${employeeId}/balances`, { method: 'POST', body });
