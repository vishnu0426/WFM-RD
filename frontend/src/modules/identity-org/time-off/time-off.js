/* Time Off — wired to attendance-leave-service (:8300). LeaveType is full
   CRUD; LeaveRequest list requires a specific orgUnitId (this service has
   no tenant-wide list endpoint, so the UI surfaces that constraint via a
   required org-unit picker rather than hiding it); there is no cancel
   endpoint on this service at all — the Requests tab correctly has no
   Cancel action rather than a button that would 404. */
import { $, esc, errMsg } from '../../../core/dom.js';
import { Api } from '../../../core/api.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, empty, stBadge, drawerShell } from '../shared/ui.js';
import { empById, empLabel } from '../shared/employee-helpers.js';
import { loadEmployees, loadUsers, loadOrgUnits } from '../shared/loaders.js';
import * as LeaveApi from '../../attendance-leave/api.js';

async function loadLeaveTypes(state) {
  if (state.wf.leaveTypes) return state.wf.leaveTypes;
  try {
    state.wf.leaveTypes = await LeaveApi.listLeaveTypes();
  } catch (err) {
    state.wf.leaveTypes = { error: errMsg(err) };
  }
  doRerender();
  return state.wf.leaveTypes;
}

/** User Management audit GAP-02: the real accrual catalog — replaces the old "random UUID pre-filled" placeholder in the Leave Type drawer. */
async function loadAccrualPolicies(state) {
  if (state.wf.accrualPolicies) return state.wf.accrualPolicies;
  try {
    state.wf.accrualPolicies = await LeaveApi.listAccrualPolicies();
  } catch (err) {
    state.wf.accrualPolicies = { error: errMsg(err) };
  }
  doRerender();
  return state.wf.accrualPolicies;
}

async function loadLeaveRequests(state, orgUnitId, status) {
  const key = `${orgUnitId}:${status || "pending"}`;
  state.wf.leaveRequestsKey = key;
  try {
    const rows = await LeaveApi.listLeaveRequests(orgUnitId, status);
    if (state.wf.leaveRequestsKey === key) state.wf.leaveRequests = rows;
  } catch (err) {
    if (state.wf.leaveRequestsKey === key) state.wf.leaveRequests = { error: errMsg(err) };
  }
  doRerender();
}

async function loadLeaveBalances(state, employeeId) {
  try {
    state.wf.leaveBalances[employeeId] = await LeaveApi.getEmployeeLeaveBalances(employeeId);
  } catch (err) {
    state.wf.leaveBalances[employeeId] = { error: errMsg(err) };
  }
  doRerender();
}

function ensureTimeOffState(state) {
  state.wf.leaveBalances = state.wf.leaveBalances || {};
  if (state.leaveStatusFilter === undefined) state.leaveStatusFilter = "pending";
}

export function render(state) {
  ensureTimeOffState(state);
  if (!state.wf.employees || !state.data.orgUnits) {
    loadEmployees(state);
    loadUsers(state);
    loadOrgUnits(state);
    return pageHead("Time Off", "Loading…", "") + `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  }
  if (!state.wf.leaveTypes) loadLeaveTypes(state);
  if (state.leaveOrgUnit === undefined) state.leaveOrgUnit = (state.data.orgUnits[0] || {}).id || null;

  const tab = state.leaveTab || "queue";
  const typesLoaded = state.wf.leaveTypes && !state.wf.leaveTypes.error;
  const types = typesLoaded ? state.wf.leaveTypes : [];
  const typeName = (id) => (types.find((t) => t.id === id) || {}).name || id;

  let body = "";
  if (tab === "queue") {
    const key = `${state.leaveOrgUnit}:${state.leaveStatusFilter}`;
    if (state.leaveOrgUnit && state.wf.leaveRequestsKey !== key) loadLeaveRequests(state, state.leaveOrgUnit, state.leaveStatusFilter);
    const requests = state.wf.leaveRequestsKey === key ? state.wf.leaveRequests : undefined;
    body = `
      <div class="toolbar">
        <select data-wf="leave-org">${state.data.orgUnits.map((o) => `<option value="${o.id}" ${state.leaveOrgUnit === o.id ? "selected" : ""}>${"— ".repeat(o.depth)}${esc(o.name)}</option>`).join("")}</select>
        <select data-wf="leave-status">${["pending", "approved", "rejected"].map((s) => `<option value="${s}" ${state.leaveStatusFilter === s ? "selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select>
        <span class="meta">GET /v1/leave/requests?orgUnitId=…&status=… — no tenant-wide list endpoint</span>
      </div>
      ${requests === undefined ? `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`
        : requests.error ? `<div class="panel"><div class="empty"><h2>Failed to load requests</h2><p>${esc(requests.error)}</p></div></div>`
        : requests.length === 0 ? empty("No requests match this org unit and status.")
        : `<table class="data"><thead><tr><th>Employee</th><th>Type</th><th>Start</th><th>End</th><th>Status</th><th>Requested</th><th></th></tr></thead>
        <tbody>${requests.map((r) => {
          const e = empById(state, r.employeeId);
          return `<tr>
            <td>${esc(e ? empLabel(state, e) : r.employeeId)}</td>
            <td>${esc(typeName(r.leaveTypeId))}</td>
            <td class="mono">${r.dateRangeStart}</td>
            <td class="mono">${r.dateRangeEnd}</td>
            <td>${stBadge(r.status)}</td>
            <td class="muted">${r.requestedAt ? new Date(r.requestedAt).toLocaleDateString() : "—"}</td>
            <td>${r.status === "pending" ? `<button class="btn btn-sm" data-wf="approve-leave" data-id="${r.id}">Approve</button> <button class="btn btn-sm" data-wf="open-reject-leave" data-id="${r.id}">Reject</button>` : ""}</td>
          </tr>`;
        }).join("")}</tbody></table>`}`;
  } else if (tab === "types") {
    if (!state.wf.accrualPolicies) loadAccrualPolicies(state);
    const policies = Array.isArray(state.wf.accrualPolicies) ? state.wf.accrualPolicies : [];
    const policyName = (id) => { const p = policies.find((x) => x.id === id); return p ? `${p.name} (${p.accrualRatePerPeriod}/${p.accrualFrequency})` : id; };
    body = (!typesLoaded
      ? (state.wf.leaveTypes && state.wf.leaveTypes.error ? `<div class="panel"><div class="empty"><h2>Failed to load leave types</h2><p>${esc(state.wf.leaveTypes.error)}</p></div></div>` : `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`)
      : `<table class="data"><thead><tr><th>Name</th><th>Accrual policy</th><th>Approval</th><th>Documentation</th><th>Max consecutive</th><th></th></tr></thead><tbody>${types.map((t) => `<tr><td>${esc(t.name)}</td><td class="mono">${esc(policyName(t.accrualPolicyId))}</td><td>${t.requiresApproval ? "Yes" : "No"}</td><td>${t.requiresDocumentation ? "Yes" : "No"}</td><td>${t.maxConsecutiveDays ?? "—"}</td><td><button class="btn btn-sm" data-wf="edit-leave-type" data-id="${t.id}">Edit</button> <button class="btn btn-sm" data-wf="delete-leave-type" data-id="${t.id}">Delete</button></td></tr>`).join("") || `<tr><td colspan="6" class="muted">No leave types yet.</td></tr>`}</tbody></table>`)
      + `<div class="panel" style="margin-top:14px"><div class="panel-h"><span>Accrual policies</span><span class="meta">GET/POST/PATCH/DELETE /v1/accrual-policies<button class="btn btn-sm" style="margin-left:12px" data-wf="open-accrual-policy">+ New policy</button></span></div>
        ${!Array.isArray(state.wf.accrualPolicies)
          ? (state.wf.accrualPolicies && state.wf.accrualPolicies.error ? `<p class="muted" style="padding:14px">${esc(state.wf.accrualPolicies.error)}</p>` : `<div style="padding:16px"><div class="skel" style="height:16px"></div></div>`)
          : `<table class="data"><thead><tr><th>Name</th><th>Rate / period</th><th>Frequency</th><th>Cap</th><th>Status</th><th></th></tr></thead><tbody>${policies.map((p) => `<tr><td>${esc(p.name)}</td><td class="mono">${p.accrualRatePerPeriod}</td><td>${p.accrualFrequency}</td><td class="mono">${p.maxBalanceCap ?? "—"}</td><td>${stBadge(p.status)}</td><td><button class="btn btn-sm" data-wf="delete-accrual-policy" data-id="${p.id}">Delete</button></td></tr>`).join("") || `<tr><td colspan="6" class="muted">No accrual policies yet — create one, then reference it when creating a leave type.</td></tr>`}</tbody></table>`}
      </div>`;
  } else {
    const emp = state.wf.employees.find((e) => e.id === state.leaveBalanceEmp) || state.wf.employees[0];
    if (emp && state.leaveBalanceEmp === undefined) state.leaveBalanceEmp = emp.id;
    const balances = emp ? state.wf.leaveBalances[emp.id] : undefined;
    if (emp && balances === undefined) loadLeaveBalances(state, emp.id);
    body = `
      <div class="split">
        <div class="split-l">${state.wf.employees.map((e) => `<button class="${e.id === state.leaveBalanceEmp ? "on" : ""}" data-wf="pick-balance-emp" data-id="${e.id}"><b>${esc(e.employeeNumber)}</b><div class="muted">${esc(empLabel(state, e))}</div></button>`).join("")}</div>
        <div class="split-r">
          ${!emp ? empty("Select an employee.")
            : balances === undefined ? `<div class="skel" style="height:24px"></div>`
            : balances.error ? `<p class="muted">${esc(balances.error)}</p>`
            : balances.length === 0 ? empty("No balances recorded for this employee.")
            : `<table class="data"><thead><tr><th>Type</th><th>Period</th><th>Accrued</th><th>Used</th><th>Pending</th><th>Available</th></tr></thead>
            <tbody>${balances.map((b) => `<tr><td>${esc(typeName(b.leaveTypeId))}</td><td class="mono">${b.periodStart} → ${b.periodEnd}</td><td>${b.accruedDays}</td><td>${b.usedDays}</td><td>${b.pendingDays}</td><td><b>${b.availableDays}</b></td></tr>`).join("")}</tbody></table>`}
        </div>
      </div>`;
  }

  return `
    ${pageHead("Time Off", "Leave requests, types, and balances — wired to attendance-leave-service.", tab === "bal"
      ? `<button class="btn btn-primary" data-wf="open-provision-balance" ${state.leaveBalanceEmp ? "" : "disabled"}>+ Provision balance</button>`
      : `<button class="btn btn-primary" data-wf="open-leave-request" ${typesLoaded ? "" : "disabled"}>+ Create request</button>`)}
    <div class="tabs">
      <button class="tab ${tab === "queue" ? "on" : ""}" data-wf="leave-tab" data-id="queue">Requests</button>
      <button class="tab ${tab === "types" ? "on" : ""}" data-wf="leave-tab" data-id="types">Types</button>
      <button class="tab ${tab === "bal" ? "on" : ""}" data-wf="leave-tab" data-id="bal">Balances</button>
      ${tab === "types" ? `<button class="btn btn-sm" style="margin-left:auto" data-wf="open-leave-type">+ Create type</button>` : ""}
    </div>
    ${body}`;
}

export function renderDrawer(state) {
  const d = state.drawer;
  if (d === "leave-request") {
    const types = state.wf.leaveTypes || [];
    const employees = state.wf.employees || [];
    state.lrDraft = state.lrDraft || {};
    if (state.lrDraft.employeeId === undefined) state.lrDraft.employeeId = employees[0]?.id || "";
    if (state.lrDraft.leaveTypeId === undefined) state.lrDraft.leaveTypeId = types[0]?.id || "";
    if (state.lrDraft.dateRangeStart === undefined) state.lrDraft.dateRangeStart = "";
    if (state.lrDraft.dateRangeEnd === undefined) state.lrDraft.dateRangeEnd = "";
    return drawerShell("Create leave request", "POST /v1/leave/requests",
      `<div class="field"><label>Employee</label><select id="lr-emp" data-wf="lr-emp-input">${employees.map((e) => `<option value="${e.id}" ${e.id === state.lrDraft.employeeId ? "selected" : ""}>${esc(empLabel(state, e))}</option>`).join("")}</select></div>
       <div class="field" style="margin-top:10px"><label>Leave type</label><select id="lr-type" data-wf="lr-type-input">${types.map((t) => `<option value="${t.id}" ${t.id === state.lrDraft.leaveTypeId ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
       <div class="grid-2" style="margin-top:10px">
         <div class="field"><label>Start date</label><input id="lr-start" data-wf="lr-start-input" type="date" value="${esc(state.lrDraft.dateRangeStart)}" /></div>
         <div class="field"><label>End date</label><input id="lr-end" data-wf="lr-end-input" type="date" value="${esc(state.lrDraft.dateRangeEnd)}" /></div>
       </div>`,
      `<button class="btn" data-wf="close-drawer">Cancel</button>`,
      `<button class="btn btn-primary" data-wf="leave-request-go" ${state.wf.saving.leave ? "disabled" : ""}>${state.wf.saving.leave ? "Submitting…" : "Submit"}</button>`);
  }
  if (d === "reject-leave") {
    return drawerShell("Reject request", "POST /v1/leave/requests/:id/decision — a reason is required to reject.",
      `<div class="field"><label>Reason</label><textarea id="lr-reject-reason"></textarea></div>`,
      `<button class="btn" data-wf="close-drawer">Cancel</button>`,
      `<button class="btn btn-primary" data-wf="reject-leave-go" data-id="${state.rejectLeaveTarget || ""}" ${state.wf.saving.leave ? "disabled" : ""}>${state.wf.saving.leave ? "Rejecting…" : "Reject"}</button>`);
  }
  if (d === "leave-type") {
    const editing = state.editLeaveTypeTarget;
    const policies = Array.isArray(state.wf.accrualPolicies) ? state.wf.accrualPolicies : [];
    state.ltDraft = state.ltDraft || {};
    if (state.ltDraft.name === undefined) state.ltDraft.name = (editing && editing.name) || "";
    if (state.ltDraft.accrualPolicyId === undefined) state.ltDraft.accrualPolicyId = (editing && editing.accrualPolicyId) || policies[0]?.id || "";
    if (state.ltDraft.maxConsecutiveDays === undefined) state.ltDraft.maxConsecutiveDays = (editing && editing.maxConsecutiveDays) || "";
    if (state.ltDraft.requiresApproval === undefined) state.ltDraft.requiresApproval = !editing || editing.requiresApproval;
    if (state.ltDraft.requiresDocumentation === undefined) state.ltDraft.requiresDocumentation = !!(editing && editing.requiresDocumentation);
    return drawerShell(editing ? "Edit leave type" : "Create leave type", editing ? "PATCH /v1/leave-types/:id" : "POST /v1/leave-types",
      `<div class="field"><label>Name</label><input id="lt-name" data-wf="lt-name-input" value="${esc(state.ltDraft.name)}" /></div>
       <div class="field" style="margin-top:10px"><label>Accrual policy</label>
         ${editing
           ? `<input value="${esc((policies.find((p) => p.id === editing.accrualPolicyId) || {}).name || editing.accrualPolicyId)}" readonly />`
           : `<select id="lt-accrual" data-wf="lt-accrual-input">${policies.length ? policies.map((p) => `<option value="${p.id}" ${p.id === state.ltDraft.accrualPolicyId ? "selected" : ""}>${esc(p.name)} (${p.accrualRatePerPeriod}/${p.accrualFrequency})</option>`).join("") : `<option value="">No accrual policies exist yet</option>`}</select>`}
         <p class="hint">${editing ? "Not editable after creation." : `No policy you need? <button type="button" class="btn btn-sm" data-wf="open-accrual-policy">+ New accrual policy</button>`}</p></div>
       <div class="grid-2" style="margin-top:10px">
         <div class="field"><label>Max consecutive days</label><input id="lt-maxdays" data-wf="lt-maxdays-input" type="number" value="${esc(state.ltDraft.maxConsecutiveDays)}" /></div>
       </div>
       <label class="toggle" style="margin-top:10px"><input type="checkbox" id="lt-approval" data-wf="lt-approval-toggle" ${state.ltDraft.requiresApproval ? "checked" : ""} /> Requires approval</label>
       <label class="toggle" style="margin-top:6px"><input type="checkbox" id="lt-docs" data-wf="lt-docs-toggle" ${state.ltDraft.requiresDocumentation ? "checked" : ""} /> Requires documentation</label>`,
      `<button class="btn" data-wf="close-drawer">Cancel</button>`,
      `<button class="btn btn-primary" data-wf="${editing ? "leave-type-edit-go" : "leave-type-go"}" ${editing ? `data-id="${editing.id}"` : ""} ${state.wf.saving.leaveType ? "disabled" : ""}>${state.wf.saving.leaveType ? "Saving…" : editing ? "Save" : "Create"}</button>`);
  }
  if (d === "accrual-policy") {
    return drawerShell("New accrual policy", "POST /v1/accrual-policies",
      `<div class="field"><label>Name</label><input id="ap-name" placeholder="e.g. Standard PTO accrual" /></div>
       <div class="grid-2" style="margin-top:10px">
         <div class="field"><label>Rate per period</label><input id="ap-rate" type="number" min="0" step="0.25" value="1" /></div>
         <div class="field"><label>Frequency</label><select id="ap-freq">
           <option value="weekly">Weekly</option>
           <option value="biweekly">Biweekly</option>
           <option value="monthly" selected>Monthly</option>
           <option value="annually">Annually</option>
         </select></div>
         <div class="field"><label>Max balance cap</label><input id="ap-cap" type="number" min="0" step="0.25" placeholder="No cap" /></div>
       </div>
       <p class="hint">Real, persisted policy — applied by a daily accrual job (LeaveAccrualJobService) to every open-period balance referencing it. No cross-service EmploymentPolicy link; this catalog lives in attendance-leave-service itself.</p>`,
      `<button class="btn" data-wf="close-drawer">Cancel</button>`,
      `<button class="btn btn-primary" data-wf="accrual-policy-go" ${state.wf.saving.accrualPolicy ? "disabled" : ""}>${state.wf.saving.accrualPolicy ? "Creating…" : "Create"}</button>`);
  }
  if (d === "provision-balance") {
    const types = state.wf.leaveTypes || [];
    state.pbDraft = state.pbDraft || {};
    if (state.pbDraft.leaveTypeId === undefined) state.pbDraft.leaveTypeId = types[0]?.id || "";
    if (state.pbDraft.periodStart === undefined) state.pbDraft.periodStart = "";
    if (state.pbDraft.periodEnd === undefined) state.pbDraft.periodEnd = "";
    if (state.pbDraft.accruedDays === undefined) state.pbDraft.accruedDays = "";
    if (state.pbDraft.carryoverDaysIn === undefined) state.pbDraft.carryoverDaysIn = "";
    return drawerShell("Provision leave balance", "POST /v1/leave/employees/:employeeId/balances — admin-only, leave_balance:write",
      `<p class="hint">For ${esc(empLabel(state, empById(state, state.leaveBalanceEmp)))}. There is no accrual engine in this backend — this creates one balance period directly; it does not recur.</p>
       <div class="field" style="margin-top:10px"><label>Leave type</label><select id="pb-type" data-wf="pb-type-input">${types.map((t) => `<option value="${t.id}" ${t.id === state.pbDraft.leaveTypeId ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
       <div class="grid-2" style="margin-top:10px">
         <div class="field"><label>Period start</label><input id="pb-start" data-wf="pb-start-input" type="date" value="${esc(state.pbDraft.periodStart)}" /></div>
         <div class="field"><label>Period end</label><input id="pb-end" data-wf="pb-end-input" type="date" value="${esc(state.pbDraft.periodEnd)}" /></div>
       </div>
       <div class="grid-2" style="margin-top:10px">
         <div class="field"><label>Accrued days</label><input id="pb-accrued" data-wf="pb-accrued-input" type="number" min="0" step="0.5" value="${esc(state.pbDraft.accruedDays)}" /></div>
         <div class="field"><label>Carryover in</label><input id="pb-carryover" data-wf="pb-carryover-input" type="number" min="0" step="0.5" value="${esc(state.pbDraft.carryoverDaysIn)}" /></div>
       </div>`,
      `<button class="btn" data-wf="close-drawer">Cancel</button>`,
      `<button class="btn btn-primary" data-wf="provision-balance-go" ${state.wf.saving.provisionBalance ? "disabled" : ""}>${state.wf.saving.provisionBalance ? "Provisioning…" : "Provision"}</button>`);
  }
  return "";
}

export function handle(state, act, id, value) {
  const set = (k, v) => { state[k] = v; return true; };
  if (act === "leave-org") return set("leaveOrgUnit", value);
  if (act === "leave-status") return set("leaveStatusFilter", value);
  if (act === "pick-balance-emp") { delete state.wf.leaveBalances[id]; return set("leaveBalanceEmp", id); }

  if (act === "open-leave-request") {
    state.lrDraft = null;
    return set("drawer", "leave-request");
  }
  if (act === "lr-emp-input") { state.lrDraft.employeeId = value; return false; }
  if (act === "lr-type-input") { state.lrDraft.leaveTypeId = value; return false; }
  if (act === "lr-start-input") { state.lrDraft.dateRangeStart = value; return false; }
  if (act === "lr-end-input") { state.lrDraft.dateRangeEnd = value; return false; }
  if (act === "leave-request-go") {
    const employeeId = state.lrDraft?.employeeId || $("#lr-emp")?.value;
    const leaveTypeId = state.lrDraft?.leaveTypeId || $("#lr-type")?.value;
    const dateRangeStart = state.lrDraft?.dateRangeStart || $("#lr-start")?.value;
    const dateRangeEnd = state.lrDraft?.dateRangeEnd || $("#lr-end")?.value;
    if (!employeeId || !leaveTypeId || !dateRangeStart || !dateRangeEnd) {
      toast("Employee, leave type, and both dates are required.");
      return true;
    }
    state.wf.saving.leave = true;
    doRerender();
    LeaveApi.createLeaveRequest({ employeeId, leaveTypeId, dateRangeStart, dateRangeEnd })
      .then(() => {
        state.wf.saving.leave = false;
        state.drawer = null;
        state.lrDraft = null;
        state.wf.leaveRequestsKey = null;
        toast("Leave request submitted.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.leave = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "approve-leave") {
    const claims = Api.currentUserClaims();
    LeaveApi.decideLeaveRequest(id, { decision: "approved", decidedBy: claims?.sub })
      .then(() => {
        state.wf.leaveRequestsKey = null;
        toast("Request approved.");
        doRerender();
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === "open-reject-leave") {
    state.rejectLeaveTarget = id;
    return set("drawer", "reject-leave");
  }
  if (act === "reject-leave-go") {
    const reason = $("#lr-reject-reason")?.value.trim();
    if (!reason) {
      toast("A reason is required to reject.");
      return true;
    }
    const claims = Api.currentUserClaims();
    state.wf.saving.leave = true;
    doRerender();
    LeaveApi.decideLeaveRequest(id, { decision: "rejected", decidedBy: claims?.sub, reason })
      .then(() => {
        state.wf.saving.leave = false;
        state.drawer = null;
        state.wf.leaveRequestsKey = null;
        toast("Request rejected.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.leave = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === "open-leave-type") {
    state.editLeaveTypeTarget = null;
    state.ltDraft = null;
    return set("drawer", "leave-type");
  }
  if (act === "edit-leave-type") {
    state.editLeaveTypeTarget = (state.wf.leaveTypes || []).find((t) => t.id === id);
    state.ltDraft = null;
    return set("drawer", "leave-type");
  }
  if (act === "lt-name-input") { state.ltDraft.name = value; return false; }
  if (act === "lt-accrual-input") { state.ltDraft.accrualPolicyId = value; return false; }
  if (act === "lt-maxdays-input") { state.ltDraft.maxConsecutiveDays = value; return false; }
  if (act === "lt-approval-toggle") { state.ltDraft.requiresApproval = !!$("#lt-approval")?.checked; return false; }
  if (act === "lt-docs-toggle") { state.ltDraft.requiresDocumentation = !!$("#lt-docs")?.checked; return false; }
  if (act === "leave-type-go" || act === "leave-type-edit-go") {
    const d = state.ltDraft || {};
    const name = (d.name || $("#lt-name")?.value || "").trim();
    const accrualPolicyId = (d.accrualPolicyId || $("#lt-accrual")?.value || "").trim();
    const maxConsecutiveDays = d.maxConsecutiveDays ? Number(d.maxConsecutiveDays) : undefined;
    const requiresApproval = d.requiresApproval !== undefined ? d.requiresApproval : !!$("#lt-approval")?.checked;
    const requiresDocumentation = d.requiresDocumentation !== undefined ? d.requiresDocumentation : !!$("#lt-docs")?.checked;
    if (!name || (act === "leave-type-go" && !accrualPolicyId)) {
      toast("Name and accrual policy ID are required.");
      return true;
    }
    state.wf.saving.leaveType = true;
    doRerender();
    const call = act === "leave-type-go"
      ? LeaveApi.createLeaveType({ name, accrualPolicyId, maxConsecutiveDays, requiresApproval, requiresDocumentation })
      : LeaveApi.updateLeaveType(id, { name, maxConsecutiveDays, requiresApproval, requiresDocumentation });
    call
      .then(() => {
        state.wf.saving.leaveType = false;
        state.wf.leaveTypes = null;
        state.ltDraft = null;
        state.drawer = null;
        toast("Leave type saved.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.leaveType = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "delete-leave-type") {
    if (!confirm("Delete this leave type? This cannot be undone.")) return true;
    LeaveApi.deleteLeaveType(id)
      .then(() => {
        state.wf.leaveTypes = null;
        toast("Leave type deleted.");
        doRerender();
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }

  if (act === "open-accrual-policy") return set("drawer", "accrual-policy");
  if (act === "accrual-policy-go") {
    const name = $("#ap-name")?.value.trim();
    const accrualRatePerPeriod = $("#ap-rate")?.value ? Number($("#ap-rate").value) : undefined;
    const accrualFrequency = $("#ap-freq")?.value;
    const capRaw = $("#ap-cap")?.value;
    if (!name || accrualRatePerPeriod === undefined) {
      toast("Name and rate per period are required.");
      return true;
    }
    state.wf.saving.accrualPolicy = true;
    doRerender();
    LeaveApi.createAccrualPolicy({ name, accrualRatePerPeriod, accrualFrequency, maxBalanceCap: capRaw ? Number(capRaw) : undefined })
      .then(() => {
        state.wf.saving.accrualPolicy = false;
        state.wf.accrualPolicies = null;
        state.drawer = null;
        toast("Accrual policy created.");
        loadAccrualPolicies(state);
      })
      .catch((err) => {
        state.wf.saving.accrualPolicy = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "delete-accrual-policy") {
    if (!confirm("Delete this accrual policy?")) return true;
    LeaveApi.deleteAccrualPolicy(id)
      .then(() => {
        state.wf.accrualPolicies = null;
        toast("Accrual policy deleted.");
        loadAccrualPolicies(state);
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }

  if (act === "open-provision-balance") {
    state.pbDraft = null;
    return set("drawer", "provision-balance");
  }
  if (act === "pb-type-input") { state.pbDraft.leaveTypeId = value; return false; }
  if (act === "pb-start-input") { state.pbDraft.periodStart = value; return false; }
  if (act === "pb-end-input") { state.pbDraft.periodEnd = value; return false; }
  if (act === "pb-accrued-input") { state.pbDraft.accruedDays = value; return false; }
  if (act === "pb-carryover-input") { state.pbDraft.carryoverDaysIn = value; return false; }
  if (act === "provision-balance-go") {
    const employeeId = state.leaveBalanceEmp;
    const leaveTypeId = state.pbDraft?.leaveTypeId || $("#pb-type")?.value;
    const periodStart = state.pbDraft?.periodStart || $("#pb-start")?.value;
    const periodEnd = state.pbDraft?.periodEnd || $("#pb-end")?.value;
    const accruedDaysRaw = state.pbDraft?.accruedDays || $("#pb-accrued")?.value;
    const carryoverRaw = state.pbDraft?.carryoverDaysIn || $("#pb-carryover")?.value;
    if (!employeeId || !leaveTypeId || !periodStart || !periodEnd || accruedDaysRaw === "" || accruedDaysRaw === undefined) {
      toast("Leave type, both period dates, and accrued days are required.");
      return true;
    }
    state.wf.saving.provisionBalance = true;
    doRerender();
    LeaveApi.provisionLeaveBalance(employeeId, {
      leaveTypeId,
      periodStart,
      periodEnd,
      accruedDays: Number(accruedDaysRaw),
      carryoverDaysIn: carryoverRaw ? Number(carryoverRaw) : undefined,
    })
      .then(() => {
        state.wf.saving.provisionBalance = false;
        delete state.wf.leaveBalances[employeeId];
        state.pbDraft = null;
        state.drawer = null;
        toast("Leave balance provisioned.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.provisionBalance = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
