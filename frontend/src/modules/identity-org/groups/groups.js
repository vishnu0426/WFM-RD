/* Groups — workforce grouping used for work-rule assignment. Not a Role, Org
   Unit, or SCIM Group. Wired to GraphQL employeeGroup CRUD +
   add/removeEmployeeToGroup. */
import { Api } from '../../../core/api.js';
import { $, esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, stBadge, drawerShell } from '../shared/ui.js';
import { empById, empName, empLabel, realOrgName } from '../shared/employee-helpers.js';
import { loadEmployeeGroups, loadEmployees, loadUsers, loadGroupDetail } from '../shared/loaders.js';

export function render(state) {
  if (!state.wf.employeeGroups || !state.wf.employees) {
    loadEmployeeGroups(state);
    loadEmployees(state);
    loadUsers(state);
    return pageHead("Groups", "Loading…", "") + `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  }
  if (state.groupId === null && state.wf.employeeGroups.length) state.groupId = state.wf.employeeGroups[0].id;
  const g0 = state.wf.employeeGroups.find((x) => x.id === state.groupId);
  if (g0 && !(g0.id in state.wf.groupDetail)) loadGroupDetail(state, g0.id);
  const detail = g0 ? state.wf.groupDetail[g0.id] : undefined;
  return `
    ${pageHead("Groups", "Workforce grouping for work-rule assignment. Not a Role, Org Unit, or SCIM Group.", `<button class="btn btn-primary" data-wf="open-group">+ Create group</button>`)}
    <div class="split">
      <div class="split-l">${state.wf.employeeGroups.map((x) => `<button class="${x.id === state.groupId ? "on" : ""}" data-wf="pick-group" data-id="${x.id}"><b>${esc(x.name)}</b>${stBadge(x.status)}</button>`).join("") || empty("No groups yet.")}</div>
      <div class="split-r">
        ${!g0 ? empty("Select a group.") : detail === undefined ? `<div class="skel" style="height:24px"></div>` : detail.error ? `<p class="muted">${esc(detail.error)}</p>` : `
        <h2 style="margin:0 0 6px;font-size:16px">${esc(detail.name)}</h2>
        <p class="muted">${esc(detail.description || "—")}</p>
        ${sec("Details", `<dl class="kv">
          <dt>Name</dt><dd>${esc(detail.name)}</dd>
          <dt>Description</dt><dd>${esc(detail.description || "—")}</dd>
          <dt>Organization</dt><dd>${detail.organizationId ? esc(realOrgName(state, detail.organizationId)) : "—"}</dd>
          <dt>Parent group</dt><dd>${detail.parentGroupId ? esc((state.wf.employeeGroups.find((x) => x.id === detail.parentGroupId) || {}).name || detail.parentGroupId) : "—"}</dd>
          <dt>Status</dt><dd>${stBadge(detail.status)}</dd>
        </dl>
        <div class="actions" style="margin-top:8px"><button class="btn btn-sm" data-wf="edit-group" data-id="${g0.id}">Edit</button></div>`)}
        ${sec("Members", `<table class="data"><thead><tr><th>Employee</th><th>Number</th><th>Organization</th><th></th></tr></thead>
          <tbody>${(detail.memberEmployeeIds || []).map((eid) => {
            const e = empById(state, eid);
            if (!e) return "";
            return `<tr><td>${esc(empName(state, e) || "—")}</td><td class="mono">${e.employeeNumber}</td><td>${esc(realOrgName(state, e.orgUnitId))}</td><td><button class="btn btn-sm" data-wf="remove-group-member" data-id="${g0.id}" data-emp="${eid}">Remove</button></td></tr>`;
          }).join("") || `<tr><td colspan="4" class="muted">No members yet.</td></tr>`}</tbody></table>
          <div class="toolbar" style="margin-top:8px">
            <select id="add-member-select-${g0.id}">${state.wf.employees.filter((e) => !(detail.memberEmployeeIds || []).includes(e.id)).map((e) => `<option value="${e.id}">${esc(empLabel(state, e))}</option>`).join("")}</select>
            <button class="btn" data-wf="add-group-member" data-id="${g0.id}">Add member</button>
          </div>`)}
        `}
      </div>
    </div>`;
}

export function renderDrawer(state) {
  if (state.drawer !== "group") return "";
  const editing = state.editGroupTarget;
  const orgOptions = state.data.orgUnits || [];
  const otherGroups = (state.wf.employeeGroups || []).filter((g) => !editing || g.id !== editing.id);
  return drawerShell(editing ? "Edit group" : "Create group", editing ? "updateEmployeeGroup" : "createEmployeeGroup { name, description, organizationId?, parentGroupId?, status? }",
    `<div class="field"><label>Name</label><input id="cg-name" value="${esc((editing && editing.name) || "")}" /></div>
     <div class="field" style="margin-top:10px"><label>Description</label><textarea id="cg-desc">${esc((editing && editing.description) || "")}</textarea></div>
     <div class="field" style="margin-top:10px"><label>Organization</label><select id="cg-org"><option value="">—</option>${orgOptions.map((o) => `<option value="${o.id}" ${editing && editing.organizationId === o.id ? "selected" : ""}>${"— ".repeat(o.depth)}${esc(o.name)}</option>`).join("")}</select></div>
     ${editing ? `<div class="field" style="margin-top:10px"><label>Parent group</label><select id="cg-parent"><option value="">—</option>${otherGroups.map((g) => `<option value="${g.id}" ${editing.parentGroupId === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select></div>
     <div class="field" style="margin-top:10px"><label>Status</label><select id="cg-status"><option value="ACTIVE" ${editing.status === "ACTIVE" ? "selected" : ""}>Active</option><option value="DISABLED" ${editing.status === "DISABLED" ? "selected" : ""}>Disabled</option></select></div>` : ""}`,
    `<button class="btn" data-wf="close-drawer">Cancel</button>`,
    `<button class="btn btn-primary" data-wf="${editing ? "group-edit-go" : "group-go"}" ${editing ? `data-id="${editing.id}"` : ""} ${state.wf.saving.group ? "disabled" : ""}>${state.wf.saving.group ? "Saving…" : editing ? "Save" : "Create"}</button>`);
}

export function handle(state, act, id, value) {
  const set = (k, v) => { state[k] = v; return true; };
  if (act === "open-group") {
    state.editGroupTarget = null;
    return set("drawer", "group");
  }
  if (act === "edit-group") {
    state.editGroupTarget = state.wf.groupDetail[id];
    return set("drawer", "group");
  }
  if (act === "group-edit-go") {
    const name = $("#cg-name")?.value.trim();
    const description = $("#cg-desc")?.value.trim() || null;
    const organizationId = $("#cg-org")?.value || null;
    const parentGroupId = $("#cg-parent")?.value || null;
    const status = $("#cg-status")?.value;
    if (!name) {
      toast("Name is required.");
      return true;
    }
    state.wf.saving.group = true;
    doRerender();
    Api.gqlFetch(
      `mutation Update($input: UpdateEmployeeGroupInput!) { updateEmployeeGroup(input: $input) { id } }`,
      { input: { id, name, description, organizationId, parentGroupId, status } }
    )
      .then(() => {
        state.wf.saving.group = false;
        state.wf.employeeGroups = null;
        delete state.wf.groupDetail[id];
        state.drawer = null;
        toast("Group saved.");
        loadEmployeeGroups(state);
        loadGroupDetail(state, id);
      })
      .catch((err) => {
        state.wf.saving.group = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "group-go") {
    const name = $("#cg-name")?.value.trim();
    const description = $("#cg-desc")?.value.trim();
    const organizationId = $("#cg-org")?.value || undefined;
    if (!name) {
      toast("Name is required.");
      return true;
    }
    state.wf.saving.group = true;
    Api.gqlFetch(
      `mutation Create($input: CreateEmployeeGroupInput!) { createEmployeeGroup(input: $input) { id } }`,
      { input: { name, description: description || undefined, organizationId } }
    )
      .then(() => {
        state.wf.saving.group = false;
        state.wf.employeeGroups = null;
        state.drawer = null;
        toast("Group created.");
        loadEmployeeGroups(state);
      })
      .catch((err) => {
        state.wf.saving.group = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "add-group-member") {
    const select = document.getElementById(`add-member-select-${id}`);
    const employeeId = select?.value;
    if (!employeeId) return true;
    Api.gqlFetch(`mutation($groupId: ID!, $employeeId: ID!) { addEmployeeToGroup(groupId: $groupId, employeeId: $employeeId) { id } }`, { groupId: id, employeeId })
      .then(() => {
        delete state.wf.groupDetail[id];
        toast("Member added.");
        loadGroupDetail(state, id);
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  if (act === "remove-group-member") {
    const groupId = id;
    const employeeId = document.querySelector(`[data-wf="remove-group-member"][data-id="${groupId}"][data-emp]`)?.dataset.emp;
    Api.gqlFetch(`mutation($groupId: ID!, $employeeId: ID!) { removeEmployeeFromGroup(groupId: $groupId, employeeId: $employeeId) { id } }`, { groupId, employeeId })
      .then(() => {
        delete state.wf.groupDetail[groupId];
        toast("Member removed.");
        loadGroupDetail(state, groupId);
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
