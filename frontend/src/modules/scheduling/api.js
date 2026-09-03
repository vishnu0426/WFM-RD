/* Scheduling (Module 04, :8100) client. Real REST wiring for the User
   Management Staffing Profile screen — ShiftTemplate + StaffingProfile
   CRUD/PATCH (WorkPattern too, since profile entries reference shift
   templates the admin needs a way to create). No x-tenant-id header needed
   — this service resolves tenant strictly from the verified JWT, unlike
   attendance-leave-service/integration-hub-service. */
import { Api } from '../../core/api.js';

export async function healthCheck() {
  return Api.schedulingApi('/healthz');
}

/* ---------- Shift Templates ---------- */
export const listShiftTemplates = () => Api.schedulingApi('/v1/scheduling/shift-templates');
export const createShiftTemplate = (body) => Api.schedulingApi('/v1/scheduling/shift-templates', { method: 'POST', body });
export const updateShiftTemplate = (id, body) => Api.schedulingApi(`/v1/scheduling/shift-templates/${id}`, { method: 'PATCH', body });
export const deleteShiftTemplate = (id) => Api.schedulingApi(`/v1/scheduling/shift-templates/${id}`, { method: 'DELETE' });

/* ---------- Work Patterns ---------- */
export const listWorkPatterns = () => Api.schedulingApi('/v1/scheduling/work-patterns');
export const createWorkPattern = (body) => Api.schedulingApi('/v1/scheduling/work-patterns', { method: 'POST', body });
export const updateWorkPattern = (id, body) => Api.schedulingApi(`/v1/scheduling/work-patterns/${id}`, { method: 'PATCH', body });
export const deleteWorkPattern = (id) => Api.schedulingApi(`/v1/scheduling/work-patterns/${id}`, { method: 'DELETE' });

/* ---------- Staffing Profiles ---------- */
export const listStaffingProfiles = () => Api.schedulingApi('/v1/scheduling/staffing-profiles');
export const createStaffingProfile = (body) => Api.schedulingApi('/v1/scheduling/staffing-profiles', { method: 'POST', body });
export const updateStaffingProfile = (id, body) => Api.schedulingApi(`/v1/scheduling/staffing-profiles/${id}`, { method: 'PATCH', body });
export const deleteStaffingProfile = (id) => Api.schedulingApi(`/v1/scheduling/staffing-profiles/${id}`, { method: 'DELETE' });

/* ---------- Shift Event Requests ("Shift Events" / "VTO Events" /
   "OT Extensions" — one model, discriminated by event_type). Note:
   event_type/status here are plain FastAPI Query params, not a
   CamelModel body, so they stay snake_case on the wire unlike every
   other request/response field in this service. */
export const listShiftEventRequests = (eventType, status) =>
  Api.schedulingApi(`/v1/scheduling/shift-event-requests?event_type=${eventType}${status ? `&status=${status}` : ''}`);
export const createShiftEventRequest = (body) => Api.schedulingApi('/v1/scheduling/shift-event-requests', { method: 'POST', body });
export const decideShiftEventRequest = (id, body) => Api.schedulingApi(`/v1/scheduling/shift-event-requests/${id}/decide`, { method: 'POST', body });

/* ---------- Project Rules ---------- */
export const listProjectRules = () => Api.schedulingApi('/v1/scheduling/project-rules');
export const createProjectRule = (body) => Api.schedulingApi('/v1/scheduling/project-rules', { method: 'POST', body });
export const updateProjectRule = (id, body) => Api.schedulingApi(`/v1/scheduling/project-rules/${id}`, { method: 'PATCH', body });
export const deleteProjectRule = (id) => Api.schedulingApi(`/v1/scheduling/project-rules/${id}`, { method: 'DELETE' });

/* ---------- Roster board ("Calendar") ----------
   Built specifically for this — see shift_assignments.py's own doc comment
   ("the roster board... needs one org unit's whole employee list's
   assignments for a week in one round trip"). Only published-schedule
   assignments are ever returned. */
export const listShiftAssignments = (employeeIds, from, to) => {
  const params = new URLSearchParams({ from, to });
  employeeIds.forEach((id) => params.append('employeeIds', id));
  return Api.schedulingApi(`/v1/scheduling/shift-assignments?${params.toString()}`);
};

/* ---------- Schedule jobs ("Mass Schedule Editor") ----------
   POST requires an Idempotency-Key header, same §3.3 contract as
   forecasting jobs. forecastRunId is required by the backend (no default)
   — a schedule can't be created without a completed Tactical Forecast run
   for the same org unit/date range first. */
export const submitScheduleJob = (body) =>
  Api.schedulingApi('/v1/scheduling/jobs', { method: 'POST', body, headers: { 'Idempotency-Key': crypto.randomUUID() } });
export const getScheduleJob = (jobId) => Api.schedulingApi(`/v1/scheduling/jobs/${jobId}`);
export const listScheduleJobs = (orgUnitId, limit = 20) => Api.schedulingApi(`/v1/scheduling/jobs?org_unit_id=${orgUnitId}&limit=${limit}`);
export const getScheduleJobSchedule = (jobId) => Api.schedulingApi(`/v1/scheduling/jobs/${jobId}/schedule`);
export const publishSchedule = (scheduleId) => Api.schedulingApi(`/v1/scheduling/schedules/${scheduleId}/publish`, { method: 'POST' });
export const overrideAssignment = (scheduleId, assignmentId, employeeId) =>
  Api.schedulingApi(`/v1/scheduling/schedules/${scheduleId}/assignments/${assignmentId}/override`, { method: 'POST', body: { employeeId } });
export const listScheduleConflicts = (scheduleId) => Api.schedulingApi(`/v1/scheduling/schedules/${scheduleId}/conflicts`);
export const resolveScheduleConflict = (scheduleId, conflictId, status) =>
  Api.schedulingApi(`/v1/scheduling/schedules/${scheduleId}/conflicts/${conflictId}/resolve`, { method: 'POST', body: { status } });
/* ReoptimizeScheduleRequest requires a full EmploymentPolicyInput plus
   every shift slot the schedule's locked assignments occupy, matched by
   (start, end, requiredSkillId) — not a bare re-solve trigger. See the
   Mass Schedule Editor screen for how the policy/shift-slot payload is
   built (small form + reconstructed from the current schedule). */
export const reoptimizeSchedule = (scheduleId, body) =>
  Api.schedulingApi(`/v1/scheduling/schedules/${scheduleId}/reoptimize`, { method: 'POST', body, headers: { 'Idempotency-Key': crypto.randomUUID() } });
