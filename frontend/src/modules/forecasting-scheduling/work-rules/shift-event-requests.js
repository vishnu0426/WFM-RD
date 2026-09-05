/* Work Rules > Shift Events / VTO Events / OT Extensions — one backend
   model (ShiftEventRequest), discriminated by event_type. See
   scheduling-service's shift_event_requests.py doc comment. Create + list +
   approve/reject only (no edit/delete endpoint exists). */
import { $, esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, drawerShell } from '../../identity-org/shared/ui.js';
import { loadEmployees, loadUsers } from '../../identity-org/shared/loaders.js';
import { empById, empLabel } from '../../identity-org/shared/employee-helpers.js';
import * as SchedulingApi from '../../scheduling/api.js';

const EVENT_TYPE_BY_TAB = {
  'wr-shift-events': 'shift_change',
  'wr-vto-events': 'vto',
  'wr-ot-extensions': 'overtime_extension',
};
const TITLE_BY_TAB = {
  'wr-shift-events': 'Shift Events',
  'wr-vto-events': 'VTO Events',
  'wr-ot-extensions': 'OT Extensions',
};

const isOk = (x) => Array.isArray(x);

function statusBadge(s) {
  const map = { pending: ["badge-warn", "Pending"], approved: ["badge-ok", "Approved"], rejected: ["badge-danger", "Rejected"] };
  const [c, l] = map[s] || ["badge-sys", s];
  return `<span class="badge ${c}"><span class="pip"></span>${l}</span>`;
}

async function loadRequests(state, eventType) {
  state.wf.shiftEventRequests = state.wf.shiftEventRequests || {};
  try {
    state.wf.shiftEventRequests[eventType] = await SchedulingApi.listShiftEventRequests(eventType);
  } catch (err) {
    state.wf.shiftEventRequests[eventType] = { error: errMsg(err) };
  }
  doRerender();
}

export function render(state) {
  const eventType = EVENT_TYPE_BY_TAB[state.tab];
  loadEmployees(state);
  loadUsers(state);
  state.wf.shiftEventRequests = state.wf.shiftEventRequests || {};
  const rows = state.wf.shiftEventRequests[eventType];
  if (!rows) loadRequests(state, eventType);

  const body = !rows
    ? `<div class="skel" style="height:24px"></div>`
    : !isOk(rows) ? `<p class="muted">${esc(rows.error)}</p>`
    : `<table class="data"><thead><tr><th>Employee</th><th>Shift date</th><th>Hours</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>${
        rows.map((r) => `<tr>
          <td>${esc(empLabel(state, empById(state, r.employeeId)))}</td>
          <td class="mono">${r.shiftDate}</td>
          <td class="mono">${r.requestedHours ?? "—"}</td>
          <td>${esc(r.reason)}</td>
          <td>${statusBadge(r.status)}${r.decisionReason ? `<div class="muted" style="font-size:11px">${esc(r.decisionReason)}</div>` : ""}</td>
          <td>${r.status === "pending" ? `<button class="btn btn-sm" data-wf="ser-approve" data-id="${r.id}">Approve</button> <button class="btn btn-sm" data-wf="ser-reject" data-id="${r.id}">Reject</button>` : ""}</td>
        </tr>`).join("") || `<tr><td colspan="6" class="muted">No requests yet.</td></tr>`
      }</tbody></table>`;

  return `
    ${pageHead(TITLE_BY_TAB[state.tab], "Wired to scheduling-service.", `<button class="btn btn-primary" data-wf="ser-open">+ New request</button>`)}
    ${sec("Requests", body)}`;
}

export function renderDrawer(state) {
  if (state.drawer !== "ser") return "";
  const eventType = EVENT_TYPE_BY_TAB[state.tab];
  const employees = isOk(state.wf.employees) ? state.wf.employees : [];
  return drawerShell(`New ${TITLE_BY_TAB[state.tab] === "OT Extensions" ? "OT extension" : TITLE_BY_TAB[state.tab].replace(/s$/, "")} request`, "Submit a new request for approval.",
    `<div class="field"><label>Employee</label><select id="ser-emp">${employees.map((e) => `<option value="${e.id}">${esc(empLabel(state, e))}</option>`).join("") || `<option value="">No employees loaded</option>`}</select></div>
     <div class="grid-2" style="margin-top:10px">
       <div class="field"><label>Shift date</label><input id="ser-date" type="date" /></div>
       <div class="field"><label>Requested hours (optional)</label><input id="ser-hours" type="number" min="0" step="0.25" /></div>
     </div>
     <div class="field" style="margin-top:10px"><label>Reason</label><input id="ser-reason" placeholder="Required" /></div>`,
    `<button class="btn" data-wf="close-drawer">Cancel</button>`,
    `<button class="btn btn-primary" data-wf="ser-go" data-id="${eventType}" ${state.wf.saving.ser ? "disabled" : ""}>${state.wf.saving.ser ? "Submitting…" : "Submit"}</button>`);
}

export function handle(state, act, id) {
  if (act === "ser-open") { state.drawer = "ser"; return true; }

  if (act === "ser-go") {
    const eventType = id;
    const employeeId = $("#ser-emp")?.value;
    const shiftDate = $("#ser-date")?.value;
    const requestedHoursRaw = $("#ser-hours")?.value;
    const reason = $("#ser-reason")?.value.trim();
    if (!employeeId) { toast("Employee is required."); return true; }
    if (!shiftDate) { toast("Shift date is required."); return true; }
    if (!reason) { toast("Reason is required."); return true; }
    state.wf.saving.ser = true;
    doRerender();
    SchedulingApi.createShiftEventRequest({
      employeeId,
      eventType,
      shiftDate,
      requestedHours: requestedHoursRaw ? Number(requestedHoursRaw) : undefined,
      reason,
    })
      .then(() => {
        state.wf.saving.ser = false;
        state.wf.shiftEventRequests[eventType] = null;
        state.drawer = null;
        toast("Request submitted.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.ser = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === "ser-approve") {
    const eventType = EVENT_TYPE_BY_TAB[state.tab];
    SchedulingApi.decideShiftEventRequest(id, { decision: "approved" })
      .then(() => {
        state.wf.shiftEventRequests[eventType] = null;
        toast("Request approved.");
        doRerender();
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === "ser-reject") {
    const eventType = EVENT_TYPE_BY_TAB[state.tab];
    const reason = prompt("Rejection reason (required):");
    if (!reason) return true;
    SchedulingApi.decideShiftEventRequest(id, { decision: "rejected", decisionReason: reason })
      .then(() => {
        state.wf.shiftEventRequests[eventType] = null;
        toast("Request rejected.");
        doRerender();
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
