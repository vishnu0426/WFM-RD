/* Work Rules — constraint sets assignable to an employee or a group. Wired
   to GraphQL workRules/createWorkRule/assignWorkRule/unassignWorkRule. */
import { Api } from '../../../core/api.js';
import { $, esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, drawerShell } from '../shared/ui.js';
import { empById, empLabel } from '../shared/employee-helpers.js';
import { loadWorkRules, loadEmployees, loadEmployeeGroups, loadUsers } from '../shared/loaders.js';

export function render(state) {
  if (!state.wf.workRules || !state.wf.employees) {
    loadWorkRules(state);
    loadEmployees(state);
    loadEmployeeGroups(state);
    loadUsers(state);
    return pageHead("Work Rules", "Loading…", "") + `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  }
  if (state.ruleId === null && state.wf.workRules.length) state.ruleId = state.wf.workRules[0].id;
  const r = state.wf.workRules.find((x) => x.id === state.ruleId);
  return `
    ${pageHead("Work Rules", "Constraint set assignable to an employee or a group.", `<button class="btn btn-primary" data-wf="open-rule">+ Create rule</button>`)}
    <div class="split">
      <div class="split-l">${state.wf.workRules.map((x) => `<button class="${x.id === state.ruleId ? "on" : ""}" data-wf="pick-rule" data-id="${x.id}"><b>${esc(x.name)}</b><div class="muted">${(x.assignments || []).length} assignment(s)</div></button>`).join("") || empty("No work rules yet.")}</div>
      <div class="split-r">
        ${!r ? empty("Select a work rule.") : `
        ${sec("WorkRule fields", `<dl class="kv">
          <dt>Name</dt><dd>${esc(r.name)}</dd>
          <dt>Description</dt><dd>${esc(r.description || "—")}</dd>
          <dt>Max consecutive days</dt><dd>${r.maxConsecutiveDays ?? "—"}</dd>
          <dt>Min rest hours</dt><dd>${r.minRestHours ?? "—"}</dd>
          <dt>Max weekly hours</dt><dd>${r.maxWeeklyHours ?? "—"}</dd>
          <dt>OT eligible</dt><dd>${r.otEligible ? "Yes" : "No"}</dd>
          <dt>Min paid hours</dt><dd class="mono">${r.minPaidHours ?? "—"}</dd>
          <dt>Max OT / day, week</dt><dd class="mono">${r.maxOtPerDay ?? "—"} / ${r.maxOtPerWeek ?? "—"}</dd>
          <dt>Max VTO / day, week</dt><dd class="mono">${r.maxVtoPerDay ?? "—"} / ${r.maxVtoPerWeek ?? "—"}</dd>
          <dt>Required pay-period hours</dt><dd class="mono">${r.requiredPayPeriodHours ?? "—"}</dd>
          <dt>Effective from / to</dt><dd class="mono">${r.effectiveFrom ?? "—"} → ${r.effectiveTo ?? "—"}</dd>
        </dl>
        <div class="actions" style="margin-top:8px"><button class="btn btn-sm" data-wf="edit-rule" data-id="${r.id}">Edit</button></div>`)}
        ${sec("Work patterns (nested, not nav)", `<p class="hint">WorkPattern lives in scheduling-service (name + days JSONB) — wired once the Staffing Profile tab's own pass reaches it.</p>`)}
        ${sec("Assignments (live)", `<p class="hint" style="margin-top:0">Priority breaks ties when an employee is covered by more than one binding (direct beats via-group at equal priority) — see <span class="mono">Employee.effectiveWorkRule</span>.</p>
          <table class="data"><thead><tr><th>Type</th><th>Assignee</th><th>Priority</th><th>Effective</th><th></th></tr></thead>
          <tbody>${(r.assignments || []).map((a) => {
            const label = a.assigneeType === "EMPLOYEE" ? empLabel(state, empById(state, a.assigneeId)) : ((state.wf.employeeGroups || []).find((g) => g.id === a.assigneeId) || {}).name || a.assigneeId;
            return `<tr><td>${a.assigneeType}</td><td>${esc(label)}</td><td class="mono">${a.priority ?? 0}</td><td class="mono">${a.effectiveFrom || "—"} → ${a.effectiveTo || "—"}</td><td><button class="btn btn-sm" data-wf="unassign-rule" data-id="${r.id}" data-type="${a.assigneeType}" data-assignee="${a.assigneeId}">Remove</button></td></tr>`;
          }).join("") || `<tr><td colspan="5" class="muted">No assignments yet.</td></tr>`}</tbody></table>
          <div class="grid-2" style="margin-top:8px">
            <div class="field"><label>Assign to</label><select id="rule-assign-target">${(state.wf.employees || []).map((e) => `<option value="employee:${e.id}">${esc(empLabel(state, e))}</option>`).join("")}${(state.wf.employeeGroups || []).map((g) => `<option value="group:${g.id}">Group: ${esc(g.name)}</option>`).join("")}</select></div>
            <div class="field"><label>Priority</label><input id="rule-assign-priority" type="number" value="0" /></div>
            <div class="field"><label>Effective from</label><input id="rule-assign-from" type="date" /></div>
            <div class="field"><label>Effective to</label><input id="rule-assign-to" type="date" /></div>
          </div>
          <button class="btn" style="margin-top:8px" data-wf="assign-rule" data-id="${r.id}">Assign</button>`)}
        `}
      </div>
    </div>`;
}

export function renderDrawer(state) {
  if (state.drawer !== "rule") return "";
  const editing = state.editRuleTarget;
  const v = (field, fallback = "") => (editing && editing[field] != null ? editing[field] : fallback);
  return drawerShell(editing ? "Edit work rule" : "Create work rule", editing ? "updateWorkRule" : "createWorkRule",
    `<div class="grid-2">
      <div class="field"><label>Name</label><input id="wr-name" value="${esc(v("name"))}" /></div>
      <div class="field"><label>Max consecutive days</label><input id="wr-maxdays" type="number" value="${v("maxConsecutiveDays")}" /></div>
      <div class="field"><label>Min rest hours</label><input id="wr-rest" type="number" step="0.01" value="${v("minRestHours")}" /></div>
      <div class="field"><label>Max weekly hours</label><input id="wr-week" type="number" step="0.01" value="${v("maxWeeklyHours")}" /></div>
      <div class="field full"><label>Description</label><textarea id="wr-desc">${esc(v("description"))}</textarea></div>
    </div>
    <label class="toggle" style="margin-top:10px"><input type="checkbox" id="wr-ot" ${editing ? (editing.otEligible ? "checked" : "") : "checked"} /> OT eligible</label>
    ${sec("Pay & overtime limits", `<div class="grid-2">
      <div class="field"><label>Min paid hours</label><input id="wr-minpaid" type="number" step="0.01" value="${v("minPaidHours")}" /></div>
      <div class="field"><label>Required pay-period hours</label><input id="wr-reqpayperiod" type="number" step="0.01" value="${v("requiredPayPeriodHours")}" /></div>
      <div class="field"><label>Max OT / day</label><input id="wr-maxotday" type="number" step="0.01" value="${v("maxOtPerDay")}" /></div>
      <div class="field"><label>Max OT / week</label><input id="wr-maxotweek" type="number" step="0.01" value="${v("maxOtPerWeek")}" /></div>
      <div class="field"><label>Max VTO / day</label><input id="wr-maxvtoday" type="number" step="0.01" value="${v("maxVtoPerDay")}" /></div>
      <div class="field"><label>Max VTO / week</label><input id="wr-maxvtoweek" type="number" step="0.01" value="${v("maxVtoPerWeek")}" /></div>
    </div>`)}
    ${sec("Effective dates", `<div class="grid-2">
      <div class="field"><label>Effective from</label><input id="wr-efffrom" type="date" value="${v("effectiveFrom")}" /></div>
      <div class="field"><label>Effective to</label><input id="wr-effto" type="date" value="${v("effectiveTo")}" /></div>
    </div>`)}`,
    `<button class="btn" data-wf="close-drawer">Cancel</button>`,
    `<button class="btn btn-primary" data-wf="${editing ? "rule-edit-go" : "rule-go"}" ${editing ? `data-id="${editing.id}"` : ""} ${state.wf.saving.rule ? "disabled" : ""}>${state.wf.saving.rule ? "Saving…" : editing ? "Save" : "Create"}</button>`);
}

function readRuleForm() {
  const num = (id) => ($(id)?.value ? Number($(id).value) : null);
  return {
    name: $("#wr-name")?.value.trim(),
    description: $("#wr-desc")?.value.trim() || null,
    maxConsecutiveDays: num("#wr-maxdays"),
    minRestHours: num("#wr-rest"),
    maxWeeklyHours: num("#wr-week"),
    otEligible: !!$("#wr-ot")?.checked,
    minPaidHours: num("#wr-minpaid"),
    maxOtPerDay: num("#wr-maxotday"),
    maxOtPerWeek: num("#wr-maxotweek"),
    maxVtoPerDay: num("#wr-maxvtoday"),
    maxVtoPerWeek: num("#wr-maxvtoweek"),
    requiredPayPeriodHours: num("#wr-reqpayperiod"),
    effectiveFrom: $("#wr-efffrom")?.value || null,
    effectiveTo: $("#wr-effto")?.value || null,
  };
}

export function handle(state, act, id, value) {
  const set = (k, v) => { state[k] = v; return true; };
  if (act === "open-rule") {
    state.editRuleTarget = null;
    return set("drawer", "rule");
  }
  if (act === "edit-rule") {
    state.editRuleTarget = (state.wf.workRules || []).find((r) => r.id === id);
    return set("drawer", "rule");
  }
  if (act === "rule-go") {
    const form = readRuleForm();
    if (!form.name) {
      toast("Name is required.");
      return true;
    }
    state.wf.saving.rule = true;
    doRerender();
    Api.gqlFetch(
      `mutation($input: CreateWorkRuleInput!) { createWorkRule(input: $input) { id } }`,
      { input: form }
    )
      .then(() => {
        state.wf.saving.rule = false;
        state.wf.workRules = null;
        state.drawer = null;
        toast("Work rule created.");
        loadWorkRules(state);
      })
      .catch((err) => {
        state.wf.saving.rule = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "rule-edit-go") {
    const form = readRuleForm();
    if (!form.name) {
      toast("Name is required.");
      return true;
    }
    state.wf.saving.rule = true;
    doRerender();
    Api.gqlFetch(
      `mutation($input: UpdateWorkRuleInput!) { updateWorkRule(input: $input) { id } }`,
      { input: { id, ...form } }
    )
      .then(() => {
        state.wf.saving.rule = false;
        state.wf.workRules = null;
        state.drawer = null;
        toast("Work rule saved.");
        loadWorkRules(state);
      })
      .catch((err) => {
        state.wf.saving.rule = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "assign-rule") {
    const target = document.getElementById("rule-assign-target")?.value || "";
    const [assigneeType, assigneeId] = target.split(":");
    if (!assigneeId) return true;
    const priority = document.getElementById("rule-assign-priority")?.value;
    const effectiveFrom = document.getElementById("rule-assign-from")?.value || undefined;
    const effectiveTo = document.getElementById("rule-assign-to")?.value || undefined;
    Api.gqlFetch(
      `mutation($input: AssignWorkRuleInput!) { assignWorkRule(input: $input) { id } }`,
      { input: { workRuleId: id, assigneeType: assigneeType.toUpperCase(), assigneeId, priority: priority ? Number(priority) : undefined, effectiveFrom, effectiveTo } }
    )
      .then(() => {
        state.wf.workRules = null;
        toast("Assigned.");
        loadWorkRules(state);
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === "unassign-rule") {
    const assigneeType = document.querySelector(`[data-wf="unassign-rule"][data-id="${id}"][data-assignee]`)?.dataset.type;
    const assigneeId = document.querySelector(`[data-wf="unassign-rule"][data-id="${id}"][data-assignee]`)?.dataset.assignee;
    Api.gqlFetch(
      `mutation($input: AssignWorkRuleInput!) { unassignWorkRule(input: $input) { id } }`,
      { input: { workRuleId: id, assigneeType, assigneeId } }
    )
      .then(() => {
        state.wf.workRules = null;
        toast("Unassigned.");
        loadWorkRules(state);
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
