/* User Access Rights — assigns roles (UserRole) to a user with an optional
   org-unit OR group scope. Distinct from Roles Setup, which manages the
   role definitions themselves. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, stBadge } from '../shared/ui.js';
import { realOrgName } from '../shared/employee-helpers.js';
import { loadUsers, loadRolesCatalog, loadOrgUnits, loadUserRoles, loadEmployeeGroups } from '../shared/loaders.js';

function groupName(state, id) {
  return (state.wf.employeeGroups || []).find((g) => g.id === id)?.name || "—";
}

export function render(state) {
  if (!state.wf.users || !state.wf.roles || !state.wf.employeeGroups) {
    loadUsers(state);
    loadRolesCatalog(state);
    loadOrgUnits(state);
    loadEmployeeGroups(state);
    return pageHead("User Access Rights", "Loading…", "") + `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  }
  if (state.userId === null && state.wf.users.length) state.userId = state.wf.users[0].id;
  const q = (state.userSearch || "").toLowerCase();
  const rows = state.wf.users.filter((u) => !q || `${u.givenName || ""} ${u.familyName || ""} ${u.email}`.toLowerCase().includes(q));
  const u = state.wf.users.find((x) => x.id === state.userId);
  if (u && !(u.id in state.wf.userRoles)) loadUserRoles(state, u.id);
  const held = u ? state.wf.userRoles[u.id] : undefined;
  return `
    ${pageHead("User Access Rights", "Assign roles to a user and set where they apply. This is UserRole, not Roles Setup.", "")}
    <div class="split">
      <div class="split-l">
        <div style="padding:8px"><input data-wf="user-search" value="${esc(state.userSearch)}" placeholder="Search user, email" style="width:100%" /></div>
        ${rows.map((x) => `<button class="${x.id === state.userId ? "on" : ""}" data-wf="pick-user" data-id="${x.id}">
          <b>${esc(x.givenName || "")} ${esc(x.familyName || "")}</b><div class="muted">${esc(x.email)}</div>${stBadge(x.status)}
        </button>`).join("")}
      </div>
      <div class="split-r">
        ${u ? `
          <h2 style="margin:0 0 4px;font-size:16px">${esc(u.givenName || "")} ${esc(u.familyName || "")}</h2>
          <p class="muted">${esc(u.email)}</p>
          ${sec("Roles", held === undefined
            ? `<div class="skel" style="height:16px"></div>`
            : held.error
            ? `<p class="muted">${esc(held.error)}</p>`
            : `<table class="data"><thead><tr><th></th><th>Role</th><th>Type</th><th>Default</th><th>Scope</th></tr></thead><tbody>
            ${state.wf.roles.map((r) => {
              const asg = held.filter((a) => a.roleId === r.id);
              const on = asg.length > 0;
              return `<tr>
                <td><input type="checkbox" ${on ? "checked" : ""} data-wf="${on ? "uar-revoke" : "uar-assign"}" data-id="${r.id}" ${state.wf.saving[r.id] ? "disabled" : ""} /></td>
                <td><b>${esc(r.name)}</b>${r.description ? `<div class="muted">${esc(r.description)}</div>` : ""}</td>
                <td>${r.isSystemRole ? `<span class="badge badge-sys">System</span>` : "Custom"}</td>
                <td>${r.isDefault ? "Yes" : "No"}</td>
                <td>${asg.map((a) => a.scopeGroupId ? `Group: ${esc(groupName(state, a.scopeGroupId))}` : a.scopeOrgUnitId ? realOrgName(state, a.scopeOrgUnitId) : "Entire organization").join(", ") || "—"}</td>
              </tr>`;
            }).join("")}
          </tbody></table>`)}
          ${sec("Assignment scope", `<p class="hint">Applies to the next role checked. Stored on UserRole.scopeOrgUnitId / scopeGroupId — mutually exclusive, exact match, not subtree. "Entire organization" already covers what other WFM systems call Installation/Enterprise scope — there is no separate tier for that in this backend's authorization model (User Management audit, GAP-04).</p>
            <label class="toggle"><input type="radio" name="sc" data-wf="scope-t" ${state.scopeMode === "tenant" ? "checked" : ""} /> Entire organization (null)</label>
            <label class="toggle"><input type="radio" name="sc" data-wf="scope-o" ${state.scopeMode === "ou" ? "checked" : ""} /> Specific organization unit</label>
            <label class="toggle"><input type="radio" name="sc" data-wf="scope-g" ${state.scopeMode === "group" ? "checked" : ""} /> Specific group</label>
            <label class="toggle"><input type="radio" name="sc" data-wf="scope-rg" ${state.scopeMode === "rootgroup" ? "checked" : ""} /> Root group only</label>
            ${state.scopeMode === "ou" ? `<div class="tree" style="margin-top:8px">${(state.data.orgUnits || []).map((o) => `<button class="${state.scopeOu === o.id ? "on" : ""} indent-${Math.min(o.depth, 3)}" data-wf="scope-ou" data-id="${o.id}">${esc(o.name)} · ${o.type.replace("_", " ")}</button>`).join("")}</div>` : ""}
            ${state.scopeMode === "group" ? `<div class="tree" style="margin-top:8px">${(state.wf.employeeGroups || []).map((g) => `<button class="${state.scopeGroup === g.id ? "on" : ""}" data-wf="scope-group" data-id="${g.id}">${esc(g.name)}</button>`).join("") || empty("No groups yet.", "Create one on the Groups screen first.")}</div>` : ""}
            ${state.scopeMode === "rootgroup" ? `<div class="tree" style="margin-top:8px">${(state.wf.employeeGroups || []).filter((g) => !g.parentGroupId).map((g) => `<button class="${state.scopeGroup === g.id ? "on" : ""}" data-wf="scope-group" data-id="${g.id}">${esc(g.name)}</button>`).join("") || empty("No root-level groups yet.", "A root group is one with no parent group.")}</div>` : ""}`)}
        ` : empty("Select a user.", "")}
      </div>
    </div>`;
}

export function handle(state, act, id, value) {
  const set = (k, v) => { state[k] = v; return true; };
  if (act === "scope-t") return set("scopeMode", "tenant");
  if (act === "scope-o") return set("scopeMode", "ou");
  if (act === "scope-g") return set("scopeMode", "group");
  if (act === "scope-rg") return set("scopeMode", "rootgroup");
  if (act === "scope-ou") return set("scopeOu", id);
  if (act === "scope-group") return set("scopeGroup", id);
  if (act === "uar-assign") {
    const scopeOrgUnitId = state.scopeMode === "ou" ? state.scopeOu || null : null;
    const scopeGroupId = state.scopeMode === "group" || state.scopeMode === "rootgroup" ? state.scopeGroup || null : null;
    state.wf.saving[id] = true;
    Api.rootApi(`/v1/users/${state.userId}/roles`, { method: "POST", body: { roleId: id, scopeOrgUnitId, scopeGroupId } })
      .then(() => {
        delete state.wf.saving[id];
        delete state.wf.userRoles[state.userId];
        toast("Role assigned.");
        loadUserRoles(state, state.userId);
      })
      .catch((err) => {
        delete state.wf.saving[id];
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "uar-revoke") {
    const held = state.wf.userRoles[state.userId] || [];
    const assignments = held.filter((a) => a.roleId === id);
    state.wf.saving[id] = true;
    Promise.all(
      assignments.map((a) => {
        const params = new URLSearchParams();
        if (a.scopeOrgUnitId) params.set("scopeOrgUnitId", a.scopeOrgUnitId);
        if (a.scopeGroupId) params.set("scopeGroupId", a.scopeGroupId);
        const q = params.toString() ? `?${params.toString()}` : "";
        return Api.rootApi(`/v1/users/${state.userId}/roles/${id}${q}`, { method: "DELETE" });
      })
    )
      .then(() => {
        delete state.wf.saving[id];
        delete state.wf.userRoles[state.userId];
        toast("Role revoked.");
        loadUserRoles(state, state.userId);
      })
      .catch((err) => {
        delete state.wf.saving[id];
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
