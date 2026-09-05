/* Roles Setup — the one screen that predates the workforce.js rewrite and
   still uses its own architecture: this module holds pure rendering + data
   functions only. All DOM event wiring (the data-act click/input/change
   listeners), the create-wizard step router, and navigation (go()) stay in
   app/shell.js, which imports these functions and calls them directly —
   see shell.js's own header comment for why that split exists. */
import { Api } from '../../../core/api.js';
import { $, esc, errMsg } from '../../../core/dom.js';
import { doRerender as render } from '../../../app/rerender.js';
import { state, currentUser } from '../../../app/state.js';
import { pageHead } from '../shared/ui.js';
import { RESOURCE_META, metaFor } from '../nav.js';
import { loadOrgUnits as loadOrgUnitsShared } from '../shared/loaders.js';
import { toast } from '../../../app/toast.js';

export const ACTIONS = ["read", "write", "approve", "delete"];
export const ACTION_LABEL = { read: "View", write: "Create / Edit", approve: "Approve", delete: "Delete" };

export function badgeStatus(s) {
    return s === "active"
      ? `<span class="badge badge-ok"><span class="pip"></span>Active</span>`
      : `<span class="badge badge-off"><span class="pip"></span>Disabled</span>`;
  }

export function orgName(id) {
    const list = state.data.orgUnits || [];
    return list.find((o) => o.id === id)?.name || (id ? "—" : "Platform");
  }

export async function loadPermissionsCatalog() {
    if (state.data.permissions) return state.data.permissions;
    const perms = await Api.rootApi("/v1/permissions");
    state.data.permissions = perms;
    return perms;
  }

export async function loadRoles() {
    state.loading = true;
    state.failList = false;
    render();
    try {
      // Audit gap-fix: both catches below used to swallow silently — an org-unit
      // load failure meant every "Owner Organization" column/filter quietly went
      // blank with no indication why, and a per-role permissions/user-count
      // failure showed 0/0, indistinguishable from a role that genuinely has
      // neither. Toast once per loadRoles() call so the admin knows the data
      // they're looking at is degraded, without spamming one toast per row.
      let degraded = false;
      const [roles] = await Promise.all([
        Api.rootApi("/v1/roles"),
        loadOrgUnitsShared(state).catch(() => { degraded = true; return []; }),
      ]);
      const enriched = await Promise.all(
        roles.map(async (r) => {
          try {
            const [perms, count] = await Promise.all([
              Api.rootApi(`/v1/roles/${r.id}/permissions`),
              Api.rootApi(`/v1/roles/${r.id}/user-count`),
            ]);
            return { ...r, _permissionIds: perms.map((p) => p.id), _userCount: count.count };
          } catch {
            degraded = true;
            return { ...r, _permissionIds: [], _userCount: 0, _loadError: true };
          }
        })
      );
      state.data.roles = enriched;
      if (degraded) toast("Some role details failed to load — permissions/user counts or organizations may be incomplete. Refresh to retry.");
    } catch (err) {
      state.failList = true;
      state.failMessage = errMsg(err);
    } finally {
      state.loading = false;
      render();
    }
  }

export async function loadRoleUsers(roleId) {
    try {
      const rows = await Api.rootApi(`/v1/roles/${roleId}/users`);
      state.roleUsers[roleId] = rows;
    } catch (err) {
      state.roleUsers[roleId] = { error: errMsg(err) };
    }
    render();
  }

export async function loadRoleActivity(roleId) {
    try {
      const q = new URLSearchParams({ resourceType: "role", resourceId: roleId }).toString();
      const data = await Api.rootApi(`/v1/audit-log?${q}`);
      state.roleActivity[roleId] = Array.isArray(data) ? data : data.items || [];
    } catch {
      state.roleActivity[roleId] = [];
    }
    render();
  }

export async function loadAssignUsers() {
    if (state.data.assignUsers) return state.data.assignUsers;
    const data = await Api.gqlFetch(`
      query { users { id email givenName familyName status employee { orgUnitId } } }
    `);
    state.data.assignUsers = data.users;
    return data.users;
  }

export function role(id) {
    return (state.data.roles || []).find((r) => r.id === id) || null;
  }

export function modulesFor(r) {
    const perms = state.data.permissions || [];
    const set = new Set();
    (r._permissionIds || []).forEach((id) => {
      const p = perms.find((x) => x.id === id);
      if (p) set.add(metaFor(p.resource).module);
    });
    return [...set];
  }

export function filteredRoles() {
    const rows0 = state.data.roles || [];
    const q = state.search.trim().toLowerCase();
    let rows = rows0.filter((r) => {
      if (q) {
        const hay = `${r.name} ${r.description || ""} ${orgName(r.organizationId)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      const f = state.filters;
      if (f.defaultRole && String(r.isDefault) !== f.defaultRole) return false;
      if (f.org && r.organizationId !== f.org) return false;
      if (f.status && r.status !== f.status) return false;
      if (f.module && !modulesFor(r).includes(f.module)) return false;
      if (f.users === "none" && r._userCount !== 0) return false;
      if (f.users === "1-20" && !(r._userCount >= 1 && r._userCount <= 20)) return false;
      if (f.users === "21+" && r._userCount < 21) return false;
      return true;
    });
    const { key, dir } = state.sort;
    rows.sort((a, b) => {
      const val = (r) => {
        if (key === "name") return r.name.toLowerCase();
        if (key === "default") return r.isDefault ? 1 : 0;
        if (key === "org") return orgName(r.organizationId).toLowerCase();
        if (key === "users") return r._userCount;
        if (key === "created") return r.createdAt;
        if (key === "updated") return r.updatedAt;
        return r.name;
      };
      const va = val(a),
        vb = val(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
    return rows;
  }

export function filterChips() {
    const labels = [];
    const f = state.filters;
    if (f.defaultRole) labels.push(["defaultRole", `Default: ${f.defaultRole === "true" ? "Yes" : "No"}`]);
    if (f.org) labels.push(["org", orgName(f.org)]);
    if (f.status) labels.push(["status", f.status === "active" ? "Active" : "Disabled"]);
    if (f.module) labels.push(["module", f.module]);
    if (f.users) labels.push(["users", `Users ${f.users}`]);
    return labels;
  }

export function listScreen() {
    const deniedCreate = !currentUser.can("role:write");
    const actions = `
      <button class="btn" data-act="refresh">Refresh</button>
      <button class="btn" data-act="export">Export</button>
      ${
        deniedCreate
          ? `<button class="btn btn-primary" disabled title="Requires role:write">+ Create Role</button>`
          : `<button class="btn btn-primary" data-act="create">+ Create Role</button>`
      }`;

    if (state.failList) {
      return (
        pageHead("Roles Setup", "Create and manage workforce roles and their access rights.", actions) +
        `<div class="panel"><div class="empty">
          <h2>Failed to load roles</h2>
          <p>${esc(state.failMessage)}</p>
          <button class="btn btn-primary" data-act="retry">Retry</button>
        </div></div>`
      );
    }

    if (state.loading || !state.data.roles) {
      return (
        pageHead("Roles Setup", "Create and manage workforce roles and their access rights.", actions) +
        `<div class="panel"><div class="panel-h">Roles</div>
        <div style="padding:16px;display:grid;gap:10px">
          ${Array.from({ length: 6 }, () => `<div class="skel" style="height:28px"></div>`).join("")}
        </div></div>`
      );
    }

    const rows = filteredRoles();
    const chips = filterChips();
    const empty = state.data.roles.length === 0;
    const orgOptions = (state.data.orgUnits || []).map((o) => [o.id, `${"— ".repeat(o.depth)}${o.name}`]);
    const moduleOptions = [...new Set(Object.values(RESOURCE_META).map((m) => m.module))];

    return `
      ${pageHead("Roles Setup", "Create and manage workforce roles and their access rights.", actions)}
      <div class="toolbar">
        <label class="search"><span aria-hidden="true">⌕</span>
          <input type="search" placeholder="Search role name, description, or owner organization" value="${esc(
            state.search
          )}" data-act="search" aria-label="Search roles" />
        </label>
        <button class="btn" data-act="toggle-filters">Filters</button>
        <span class="meta">${rows.length} roles</span>
      </div>
      ${
        state.selected.size > 0
          ? `<div class="toolbar" style="margin-bottom:10px">
              <span class="meta">${state.selected.size} selected</span>
              <button class="btn btn-sm" data-act="bulk-enable">Enable</button>
              <button class="btn btn-sm" data-act="bulk-disable">Disable</button>
              <button class="btn btn-sm" data-act="bulk-clear-selection">Clear selection</button>
              <p class="hint" style="margin:4px 0 0">System roles in the selection are skipped — they cannot be disabled.</p>
            </div>`
          : ""
      }
      ${
        state.filterOpen
          ? `<div class="panel" style="margin-bottom:10px;padding:12px">
        <div class="grid-2">
          ${selectField("Default Role", "f-defaultRole", [["", "Any"], ["true", "Yes"], ["false", "No"]], state.filters.defaultRole)}
          ${selectField("Owner Organization", "f-org", [["", "Any"], ...orgOptions], state.filters.org)}
          ${selectField("Status", "f-status", [["", "Any"], ["active", "Active"], ["disabled", "Disabled"]], state.filters.status)}
          ${selectField("Module Access", "f-module", [["", "Any"], ...moduleOptions.map((m) => [m, m])], state.filters.module)}
          ${selectField("User Count", "f-users", [["", "Any"], ["none", "None"], ["1-20", "1–20"], ["21+", "21+"]], state.filters.users)}
        </div>
        <div class="actions" style="margin-top:12px">
          <button class="btn" data-act="clear-filters">Clear All</button>
          <button class="btn btn-primary" data-act="apply-filters">Apply</button>
        </div>
      </div>`
          : ""
      }
      ${
        chips.length
          ? `<div class="chips" style="margin-bottom:10px">${chips
              .map(([k, l]) => `<span class="chip">${esc(l)} <button data-act="chip-x" data-id="${k}" aria-label="Remove ${esc(l)}">×</button></span>`)
              .join("")}</div>`
          : ""
      }
      <div class="panel">
        ${
          empty
            ? `<div class="empty">
                <h2>No roles have been created yet.</h2>
                <p>Custom roles are tenant-scoped. System roles (platform_admin, tenant_admin, employee) appear once seed has run.</p>
                ${deniedCreate ? "" : `<button class="btn btn-primary" data-act="create">Create Role</button>`}
              </div>`
            : `<div class="panel-h"><span>Roles</span></div>
        <div style="overflow:auto">
        <table class="data" aria-label="Roles">
          <thead>
            <tr>
              <th style="width:36px"><input type="checkbox" data-act="sel-all" aria-label="Select all" /></th>
              ${th("name", "Role Name")}
              ${th("default", "Default Role")}
              <th>Description</th>
              ${th("org", "Owner Organization")}
              <th>Modules / Access</th>
              ${th("users", "Users")}
              <th>Status</th>
              ${th("updated", "Last Updated")}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length
              ? rows.map(roleRow).join("")
              : `<tr><td colspan="9"><div class="empty" style="padding:24px"><h2>No roles match your search or filters.</h2><p>Try clearing the search box or filters above.</p><button class="btn" data-act="clear-filters">Clear filters</button></div></td></tr>`
            }
          </tbody>
        </table>
        </div>`
        }
      </div>
      ${state.menu ? rowMenu() : ""}
    `;
  }

export function th(key, label) {
    const on = state.sort.key === key;
    return `<th class="${on ? "sorted" : ""}" data-act="sort" data-id="${key}">${label}${on ? (state.sort.dir > 0 ? " ↑" : " ↓") : ""}</th>`;
  }

export function selectField(label, id, opts, val) {
    return `<div class="field"><label for="${id}">${label}</label>
      <select id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${String(val) === String(v) ? "selected" : ""}>${l}</option>`).join("")}</select>
    </div>`;
  }

export function roleRow(r) {
    const mods = modulesFor(r);
    const shown = mods.slice(0, 3);
    const more = mods.length - shown.length;
    const sys = r.isSystemRole;
    return `<tr class="${state.selected.has(r.id) ? "selected" : ""}">
      <td><input type="checkbox" data-act="sel" data-id="${r.id}" ${state.selected.has(r.id) ? "checked" : ""} aria-label="Select ${esc(r.name)}" /></td>
      <td>
        <a class="row-link" href="#" data-act="open" data-id="${r.id}">${esc(r.name)}</a>
        ${sys ? `<div><span class="badge badge-sys">System role</span></div>` : ""}
      </td>
      <td>${r.isDefault ? `<span class="badge-yes">Yes</span>` : `<span class="badge-no">No</span>`}</td>
      <td class="muted">${esc(r.description || "—")}</td>
      <td>${esc(orgName(r.organizationId))}</td>
      <td><div class="mods">${shown.map((m) => `<span class="mod">${esc(m)}</span>`).join("")}${
        more > 0 ? `<span class="mod more">+${more}</span>` : ""
      }</div></td>
      <td class="mono">${r._userCount ?? 0}${r._loadError ? ` <span class="badge badge-warn" title="Permissions/user count failed to load — this may not be accurate">⚠</span>` : ""}</td>
      <td>${badgeStatus(r.status)}</td>
      <td class="muted hide-md">${fmt(r.updatedAt)}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-sm" data-act="open" data-id="${r.id}">View</button>
          <button class="icon-btn" data-act="menu" data-id="${r.id}" aria-label="More actions for ${esc(r.name)}">⋯</button>
        </div>
      </td>
    </tr>`;
  }

export function fmt(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

export function rowMenu() {
    const r = role(state.menu);
    if (!r) return "";
    const sys = r.isSystemRole;
    const canEdit = currentUser.can("role:write") && !sys;
    const canDel = currentUser.can("role:delete") && !sys;
    return `<div class="menu-pop" style="position:fixed;right:36px;top:220px">
      <button data-act="open" data-id="${r.id}">View</button>
      <button ${canEdit ? `data-act="edit" data-id="${r.id}"` : "disabled"} title="${sys ? "System roles cannot be edited" : "Requires role:write"}">Edit</button>
      <button data-act="dup" data-id="${r.id}">Duplicate</button>
      <button data-act="assign" data-id="${r.id}">Assign Users</button>
      <button ${canEdit ? `data-act="toggle-status" data-id="${r.id}"` : "disabled"} title="${sys ? "System roles cannot be edited" : "Requires role:write"}">${r.status === "active" ? "Disable" : "Activate"}</button>
      <button class="danger" ${canDel ? `data-act="delete" data-id="${r.id}"` : "disabled"} title="${
      sys ? "System roles cannot be deleted" : "Requires role:delete"
    }">Delete</button>
    </div>`;
  }

export function wizardChrome(title, body, footLeft, footRight) {
    const w = state.wizard;
    const steps = [
      [1, "Basic Information"],
      [2, "Modules & Permissions"],
      [3, "Default Assignment Scope"],
      [4, "Review"],
    ];
    return `
      <div class="drawer-scrim" data-act="close-drawer">
        <div class="drawer wide" role="dialog" aria-modal="true" aria-labelledby="wiz-title">
          <div class="drawer-h">
            <div><h2 id="wiz-title">${title}</h2></div>
            <button class="icon-btn" data-act="close-drawer" aria-label="Close">×</button>
          </div>
          <div class="drawer-b">
            <div class="steps" aria-label="Create role progress">
              ${steps
                .map(
                  ([n, l]) =>
                    `<div class="step ${w.step === n ? "on" : ""} ${w.step > n ? "done" : ""}"><b>Step ${n}</b>${l}</div>`
                )
                .join("")}
            </div>
            ${body}
          </div>
          <div class="drawer-f">
            <div>${footLeft}</div>
            <div class="actions">${footRight}</div>
          </div>
        </div>
      </div>`;
  }

export function createBasic() {
    const w = state.wizard;
    const orgOptions = state.data.orgUnits || [];
    const body = `
      <div class="grid-2">
        <div class="field">
          <label>Role Name <span class="req">*</span></label>
          <input type="text" id="w-name" class="${w.nameError ? "invalid" : ""}" value="${esc(w.name)}" maxlength="100" />
          <span class="hint">Unique within the tenant.</span>
          ${w.nameError ? `<span class="err">${esc(w.nameError)}</span>` : ""}
        </div>
        <div class="field">
          <label>Owner Organization</label>
          <select id="w-org">
            <option value="">Platform (no owner org)</option>
            ${orgOptions
              .map((o) => `<option value="${o.id}" ${w.organizationId === o.id ? "selected" : ""}>${"— ".repeat(o.depth)}${esc(o.name)}</option>`)
              .join("")}
          </select>
        </div>
        <div class="field full">
          <label>Description</label>
          <textarea id="w-desc">${esc(w.description)}</textarea>
        </div>
      </div>
      <div style="display:grid;gap:10px;margin-top:14px">
        <label class="toggle">
          <span class="switch ${w.isDefault ? "on" : ""}" data-act="tog-default"><i></i></span>
          <span><b>Default Role</b><div class="hint">New users can be assigned this role by default when applicable.</div></span>
        </label>
        <div class="field">
          <label>Status</label>
          <div class="seg">
            <button class="${w.status === "active" ? "on" : ""}" data-act="st-active">Active</button>
            <button class="${w.status === "disabled" ? "on" : ""}" data-act="st-disabled">Disabled</button>
          </div>
        </div>
      </div>`;
    return (
      listScreen() +
      wizardChrome(
        "Create Role",
        body,
        `<button class="btn" data-act="close-drawer">Cancel</button>`,
        `<button class="btn btn-primary" data-act="wiz-next">Continue</button>`
      )
    );
  }

export function permMatrix(selectedSet, { locked = false } = {}) {
    const perms = state.data.permissions || [];
    const groups = [...new Set(perms.map((p) => metaFor(p.resource).group))];
    const active = groups.includes(state.permGroup) ? state.permGroup : groups[0];
    const q = state.permSearch.toLowerCase();
    const resourcesInGroup = [
      ...new Map(
        perms.filter((p) => metaFor(p.resource).group === active).map((p) => [p.resource, metaFor(p.resource)])
      ).entries(),
    ]
      .map(([resource, meta]) => ({ resource, ...meta }))
      .filter((r) => !q || r.label.toLowerCase().includes(q) || r.resource.includes(q));
    const countSel = selectedSet.size;
    return `
      <div class="toolbar">
        <label class="search"><span>⌕</span><input type="search" placeholder="Search permissions" value="${esc(
          state.permSearch
        )}" data-act="perm-search" /></label>
        <label class="btn" style="gap:8px"><input type="checkbox" data-act="sel-only" ${state.permSelectedOnly ? "checked" : ""} /> Selected only</label>
        <span class="meta">Selected: ${countSel} / ${perms.length}</span>
        ${locked ? "" : `<button class="btn btn-sm" data-act="sel-all-perm">Select All</button><button class="btn btn-sm" data-act="clr-all-perm">Clear All</button>`}
      </div>
      <div class="modules">
        <nav class="mod-nav" aria-label="Module groups">
          ${groups
            .map((g) => {
              const n = perms.filter((p) => metaFor(p.resource).group === g && selectedSet.has(p.id)).length;
              return `<button class="${active === g ? "on" : ""}" data-act="perm-group" data-id="${g}">${g}<span class="muted">${n}</span></button>`;
            })
            .join("")}
        </nav>
        <div class="mod-body">
          <div class="actions" style="margin-bottom:8px">
            ${locked ? "" : `<button class="btn btn-sm" data-act="sel-mod">Select module</button><button class="btn btn-sm" data-act="clr-mod">Clear module</button>`}
          </div>
          <div class="perm-row head"><span>Resource</span><span>View</span><span>Create/Edit</span><span>Approve</span><span>Delete</span></div>
          ${resourcesInGroup
            .map((r) => {
              const cells = ACTIONS.map((a) => {
                const p = perms.find((x) => x.resource === r.resource && x.action === a);
                if (!p) return `<span class="na">—</span>`;
                if (state.permSelectedOnly && !selectedSet.has(p.id)) return `<span class="na">—</span>`;
                const on = selectedSet.has(p.id);
                return `<button class="check ${on ? "on" : ""}" data-act="tog-perm" data-id="${p.id}" aria-pressed="${on}" aria-disabled="${locked}" ${
                  locked ? "disabled" : ""
                } aria-label="${r.label} ${ACTION_LABEL[a]}">${on ? "✓" : ""}</button>`;
              }).join("");
              return `<div class="perm-row"><div><b>${esc(r.label)}</b><div class="muted mono">${r.resource}</div></div>${cells}</div>`;
            })
            .join("")}
        </div>
      </div>`;
  }

export function createPerms() {
    const body = `
      <p class="hint" style="margin-top:0">The full permission catalog for this tenant.</p>
      ${permMatrix(state.wizard.perms)}`;
    return (
      listScreen() +
      wizardChrome(
        "Create Role",
        body,
        `<button class="btn" data-act="wiz-back">Back</button>`,
        `<button class="btn btn-primary" data-act="wiz-next">Continue</button>`
      )
    );
  }

export function createScope() {
    const w = state.wizard;
    const body = `
      <p class="hint" style="margin-top:0">Permissions apply only within the selected organizational scope when a user is assigned this role — scope is stored per-assignment (<span class="mono">UserRole.scopeOrgUnitId</span>), not on the role itself. This is just the default offered on the Assign Users screen.</p>
      <div style="display:grid;gap:10px;margin-top:12px">
        <label class="toggle"><input type="radio" name="scope" data-act="scope-tenant" ${w.scope === "tenant" ? "checked" : ""} /> <span><b>Entire Organization</b><div class="hint">scopeOrgUnitId = null (tenant-wide grant).</div></span></label>
        <label class="toggle"><input type="radio" name="scope" data-act="scope-ou" ${w.scope === "ou" ? "checked" : ""} /> <span><b>Specific Organization Unit</b><div class="hint">ABAC match is exact org-unit id, not subtree.</div></span></label>
      </div>
      ${
        w.scope === "ou"
          ? `<div class="tree" style="margin-top:12px" role="listbox" aria-label="Organization units">
              ${(state.data.orgUnits || [])
                .map(
                  (o) =>
                    `<button class="indent-${Math.min(o.depth, 3)} ${w.scopeOu === o.id ? "on" : ""}" data-act="pick-ou" data-id="${o.id}">${esc(
                      o.name
                    )} <span class="muted">· ${o.type.replace("_", " ")}</span></button>`
                )
                .join("")}
            </div>`
          : ""
      }`;
    return (
      listScreen() +
      wizardChrome(
        "Create Role",
        body,
        `<button class="btn" data-act="wiz-back">Back</button>`,
        `<button class="btn btn-primary" data-act="wiz-next">Continue</button>`
      )
    );
  }

export function createReview() {
    const w = state.wizard;
    const perms = state.data.permissions || [];
    const mods = [...new Set([...w.perms].map((id) => metaFor(perms.find((p) => p.id === id)?.resource || "").module))];
    const body = `
      <dl class="review">
        <dt>Role Name</dt><dd>${esc(w.name) || "—"}</dd>
        <dt>Description</dt><dd>${esc(w.description) || "—"}</dd>
        <dt>Default Role</dt><dd>${w.isDefault ? "Yes" : "No"}</dd>
        <dt>Status</dt><dd>${w.status === "active" ? "Active" : "Disabled"}</dd>
        <dt>Owner Organization</dt><dd>${esc(orgName(w.organizationId))}</dd>
        <dt>Modules</dt><dd>${mods.join(", ") || "No module access has been configured."}</dd>
        <dt>Permissions</dt><dd>${w.perms.size} of ${perms.length}</dd>
        <dt>Default assignment scope</dt><dd>${w.scope === "tenant" ? "Entire organization" : orgName(w.scopeOu) || "Unit not selected"}</dd>
      </dl>
      <div class="callout" style="margin-top:14px">Creates the role with the fields above, then binds each selected permission.</div>`;
    return (
      listScreen() +
      wizardChrome(
        "Create Role",
        body,
        `<button class="btn" data-act="wiz-back">Back</button>`,
        `<button class="btn btn-primary" data-act="wiz-create" ${state.saving ? "disabled" : ""}>${state.saving ? "Creating…" : "Create"}</button>`
      )
    );
  }

export function detail(tab) {
    const r = role(state.roleId);
    if (!r) return listScreen();
    const sys = r.isSystemRole;
    const canEdit = currentUser.can("role:write") && !sys;
    const canDel = currentUser.can("role:delete") && !sys;
    const mods = modulesFor(r);
    const header = `
      ${pageHead(
        esc(r.name),
        "Roles Setup / " + esc(r.name),
        `${sys ? `<span class="badge badge-sys">System role</span>` : `<span class="badge badge-ok">Custom</span>`}
         ${badgeStatus(r.status)}
         ${canEdit ? `<button class="btn" data-act="edit" data-id="${r.id}">Edit</button>` : `<button class="btn" disabled title="${sys ? "System roles cannot be edited" : "Requires role:write"}">Edit</button>`}
         <button class="btn" data-act="dup" data-id="${r.id}">Duplicate</button>
         ${canDel ? `<button class="btn" data-act="delete" data-id="${r.id}">Delete</button>` : `<button class="btn" disabled title="${sys ? "System roles cannot be deleted" : "Requires role:delete"}">Delete</button>`}`
      )}
      <div class="tabs">
        ${["overview", "permissions", "users"]
          .map((t) => `<button class="tab ${tab === t ? "on" : ""}" data-act="dtab" data-id="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`)
          .join("")}
      </div>`;

    if (tab === "overview") {
      if (!(r.id in state.roleActivity)) loadRoleActivity(r.id);
      const act = state.roleActivity[r.id];
      return (
        header +
        `<div class="summary">
          <div><div class="n">${mods.length}</div><div class="l">Modules</div></div>
          <div><div class="n">${(r._permissionIds || []).length}</div><div class="l">Permissions</div></div>
          <div><div class="n">${r._userCount ?? 0}</div><div class="l">Assigned users</div></div>
          <div><div class="n">${r.organizationId ? 1 : 0}</div><div class="l">Owner org set</div></div>
        </div>
        <div class="panel" style="margin-top:14px">
          <div class="panel-h">Role information</div>
          <div style="padding:14px">
            <dl class="kv">
              <dt>Role Name</dt><dd>${esc(r.name)}</dd>
              <dt>Description</dt><dd>${esc(r.description || "—")}</dd>
              <dt>Default Role</dt><dd>${r.isDefault ? "Yes" : "No"}</dd>
              <dt>Role Type</dt><dd>${r.isSystemRole ? "System" : "Custom"}</dd>
              <dt>Status</dt><dd>${r.status}</dd>
              <dt>Owner Organization</dt><dd>${r.organizationId ? esc(orgName(r.organizationId)) : "Platform"}</dd>
              <dt>Created</dt><dd class="mono">${fmt(r.createdAt)}</dd>
              <dt>Updated</dt><dd class="mono">${fmt(r.updatedAt)}</dd>
            </dl>
          </div>
        </div>
        <div class="panel" style="margin-top:14px">
          <div class="panel-h">Activity</div>
          <div style="padding:14px">
            ${
              act === undefined
                ? `<div class="skel" style="height:16px"></div>`
                : act.length === 0
                ? `<p class="muted">No recorded activity for this role.</p>`
                : `<div class="timeline">
                    ${act
                      .map(
                        (a) =>
                          `<div class="tl"><div class="when">${fmt(a.createdAt || a.at)}</div><b>${esc(a.action)}</b>${
                            a.actorId ? ` · <span class="mono">${esc(a.actorId)}</span>` : ""
                          }</div>`
                      )
                      .join("")}
                  </div>`
            }
          </div>
        </div>`
      );
    }

    if (tab === "permissions") {
      const set = new Set(r._permissionIds || []);
      return (
        header +
        `<p class="hint" style="margin-top:0">${
          sys ? "System role permissions are seed-managed. The matrix is read-only." : "Changes bind/unbind immediately."
        }</p>
        ${(r._permissionIds || []).length === 0 ? `<div class="callout">No permissions are configured.</div>` : ""}
        ${permMatrix(set, { locked: sys || !currentUser.can("role:write") })}`
      );
    }

    // users
    if (!(r.id in state.roleUsers)) loadRoleUsers(r.id);
    const known = state.roleUsers[r.id];
    return (
      header +
      `<div class="toolbar">
        <button class="btn btn-primary" data-act="assign" data-id="${r.id}">+ Assign Users</button>
        <span class="meta">${r._userCount ?? 0} assigned</span>
      </div>
      ${
        known === undefined
          ? `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`
          : known.error
          ? `<div class="panel"><div class="empty"><h2>Failed to load users</h2><p>${esc(known.error)}</p></div></div>`
          : known.length === 0
          ? `<div class="panel"><div class="empty"><h2>No users are assigned to this role.</h2></div></div>`
          : `<div class="panel"><table class="data" aria-label="Assigned users">
              <thead><tr><th>User</th><th>Status</th><th>Scope</th><th>Actions</th></tr></thead>
              <tbody>
                ${known
                  .map(
                    (u) => `<tr>
                      <td><b>${esc(u.givenName || "")} ${esc(u.familyName || "")}</b><div class="muted">${esc(u.email)}</div></td>
                      <td>${(u.status || "").toUpperCase() === "ACTIVE" ? badgeStatus("active") : (u.status || "").toUpperCase() === "DISABLED" ? badgeStatus("disabled") : `<span class="badge badge-warn">Invited</span>`}</td>
                      <td>${u.scopeOrgUnitId ? esc(orgName(u.scopeOrgUnitId)) : "Entire organization"}</td>
                      <td><button class="btn btn-sm" data-act="revoke" data-id="${u.id}" data-scope="${u.scopeOrgUnitId || ""}">Remove</button></td>
                    </tr>`
                  )
                  .join("")}
              </tbody></table></div>`
      }`
    );
  }

export function assignDrawer() {
    const r = role(state.roleId);
    if (!r) return listScreen();
    if (!state.data.assignUsers) {
      loadAssignUsers().then(render);
      return detail("users") + `<div class="drawer-scrim"><div class="drawer"><div class="drawer-b"><div class="skel" style="height:24px"></div></div></div></div>`;
    }
    const q = state.assign.search.toLowerCase();
    const list = state.data.assignUsers.filter((u) => {
      if (q && !`${u.givenName || ""} ${u.familyName || ""} ${u.email}`.toLowerCase().includes(q)) return false;
      if (state.assign.org && u.employee?.orgUnitId !== state.assign.org) return false;
      if (state.assign.status && u.status !== state.assign.status) return false;
      return true;
    });
    const n = state.assign.selected.size;
    const orgOptions = state.data.orgUnits || [];
    return (
      detail("users") +
      `<div class="drawer-scrim" data-act="close-drawer">
        <div class="drawer" role="dialog" aria-modal="true" aria-labelledby="as-title">
          <div class="drawer-h"><div><h2 id="as-title">Assign Users</h2><p>Role: ${esc(r.name)}</p></div>
          <button class="icon-btn" data-act="close-drawer" aria-label="Close">×</button></div>
          <div class="drawer-b">
            <div class="toolbar">
              <label class="search"><span>⌕</span><input data-act="as-search" value="${esc(state.assign.search)}" placeholder="Search users" /></label>
            </div>
            <div class="grid-2">
              ${selectField("Organization Unit", "as-org", [["", "Any"], ...orgOptions.map((o) => [o.id, `${"— ".repeat(o.depth)}${o.name}`])], state.assign.org)}
              ${selectField("Status", "as-st", [["", "Any"], ["ACTIVE", "Active"], ["INVITED", "Invited"], ["DISABLED", "Disabled"]], state.assign.status)}
            </div>
            <p class="meta" style="margin:10px 0">Selected Users: ${n} · Role: ${esc(r.name)} · Scope: ${
        state.assign.scope === "tenant" ? "Entire organization" : orgName(state.assign.scopeOu) || "Select unit"
      }</p>
            <div class="tree">
              ${list
                .map((u) => {
                  const on = state.assign.selected.has(u.id);
                  return `<button class="${on ? "on" : ""}" data-act="as-tog" data-id="${u.id}">
                    <b>${esc(u.givenName || "")} ${esc(u.familyName || "")}</b> · ${esc(u.email)}
                    <div class="muted">${u.status}</div>
                  </button>`;
                })
                .join("") || `<div class="empty" style="padding:24px"><p>No users match.</p></div>`}
            </div>
            <div style="margin-top:12px">
              <label class="toggle"><input type="radio" name="ascope" data-act="as-scope-t" ${
                state.assign.scope === "tenant" ? "checked" : ""
              } /> Entire Organization</label>
              <label class="toggle"><input type="radio" name="ascope" data-act="as-scope-o" ${
                state.assign.scope === "ou" ? "checked" : ""
              } /> Specific Organization Unit</label>
              ${
                state.assign.scope === "ou"
                  ? `<div class="tree" style="margin-top:8px">${orgOptions
                      .map((o) => `<button class="${state.assign.scopeOu === o.id ? "on" : ""}" data-act="as-ou" data-id="${o.id}">${"— ".repeat(o.depth)}${esc(o.name)}</button>`)
                      .join("")}</div>`
                  : ""
              }
            </div>
          </div>
          <div class="drawer-f">
            <button class="btn" data-act="close-drawer">Cancel</button>
            <button class="btn btn-primary" data-act="as-go" ${n && !state.saving ? "" : "disabled"}>${state.saving ? "Assigning…" : "Assign Role"}</button>
          </div>
        </div>
      </div>`
    );
  }

export function duplicateModal() {
    const r = role(state.roleId);
    if (!r) return listScreen();
    return (
      (state.screen === "list" ? listScreen() : detail("overview")) +
      `<div class="modal-scrim" data-act="close-modal">
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-h">Duplicate Role</div>
          <div class="modal-b">
            <p class="hint">Creates a new custom role, then copies permission bindings if selected.</p>
            <div class="field"><label>New Role Name <span class="req">*</span></label>
              <input id="dup-name" type="text" value="${esc(state.dup.name)}" /></div>
            <div class="field" style="margin-top:10px"><label>Description</label>
              <textarea id="dup-desc">${esc(state.dup.description)}</textarea></div>
            <label class="toggle" style="margin-top:10px"><input type="checkbox" data-act="dup-p" ${
              state.dup.copyPerms ? "checked" : ""
            } /> Copy Permissions</label>
            <div class="callout" style="margin-top:12px">Users assigned to the original role will not be copied.</div>
            <div class="muted" style="margin-top:8px">Source: ${esc(r.name)}</div>
          </div>
          <div class="modal-f">
            <button class="btn" data-act="close-modal">Cancel</button>
            <button class="btn btn-primary" data-act="dup-go" ${state.saving ? "disabled" : ""}>${state.saving ? "Duplicating…" : "Duplicate"}</button>
          </div>
        </div>
      </div>`
    );
  }

export function editDrawer() {
    const r = role(state.roleId);
    if (!r) return listScreen();
    const sys = r.isSystemRole;
    if (sys) {
      return (
        detail("overview") +
        `<div class="modal-scrim" data-act="close-modal"><div class="modal"><div class="modal-h">Cannot edit system role</div>
        <div class="modal-b">System roles are seed-managed and cannot be edited through this screen.</div>
        <div class="modal-f"><button class="btn" data-act="close-modal">Close</button></div></div></div>`
      );
    }
    const e = state.edit;
    const orgOptions = state.data.orgUnits || [];
    return (
      detail("overview") +
      `<div class="drawer-scrim" data-act="close-drawer"><div class="drawer" role="dialog" aria-modal="true">
        <div class="drawer-h"><div><h2>Edit ${esc(r.name)}</h2><p>Update this role’s name and description.</p></div>
          <button class="icon-btn" data-act="close-drawer">×</button></div>
        <div class="drawer-b">
          <div class="field"><label>Role Name</label><input id="ed-name" value="${esc(e.name ?? r.name)}" /></div>
          <div class="field" style="margin-top:10px"><label>Description</label><textarea id="ed-desc">${esc(e.description ?? r.description ?? "")}</textarea></div>
          <div class="field" style="margin-top:10px"><label>Owner Organization</label>
            <select id="ed-org">
              <option value="">Platform (no owner org)</option>
              ${orgOptions.map((o) => `<option value="${o.id}" ${(e.organizationId ?? r.organizationId) === o.id ? "selected" : ""}>${"— ".repeat(o.depth)}${esc(o.name)}</option>`).join("")}
            </select>
          </div>
          <label class="toggle" style="margin-top:10px">
            <span class="switch ${(e.isDefault ?? r.isDefault) ? "on" : ""}" data-act="ed-tog-default"><i></i></span>
            <span><b>Default Role</b></span>
          </label>
        </div>
        <div class="drawer-f"><button class="btn" data-act="close-drawer">Cancel</button>
          <button class="btn btn-primary" data-act="edit-save" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save"}</button></div>
      </div></div>`
    );
  }

export function deleteModal() {
    const r = role(state.roleId);
    if (!r) return listScreen();
    const n = r._userCount ?? 0;
    const sys = r.isSystemRole;
    return (
      listScreen() +
      `<div class="modal-scrim" data-act="close-modal"><div class="modal" role="dialog" aria-modal="true">
        <div class="modal-h">Delete role</div>
        <div class="modal-b">
          ${
            sys
              ? `<div class="callout danger">Delete is not offered for system roles.</div>`
              : `<dl class="review">
                  <dt>Role</dt><dd>${esc(r.name)}</dd>
                  <dt>Assigned Users</dt><dd>${n}</dd>
                  <dt>Permissions</dt><dd>${(r._permissionIds || []).length}</dd>
                  <dt>Owner Organization</dt><dd>${r.organizationId ? esc(orgName(r.organizationId)) : "—"}</dd>
                </dl>
                ${
                  n
                    ? `<div class="callout danger" style="margin-top:12px">This role is currently assigned to ${n} users. Deleting it revokes the permissions it grants immediately.</div>`
                    : `<div class="callout" style="margin-top:12px">No users currently hold this role.</div>`
                }`
          }
        </div>
        <div class="modal-f">
          <button class="btn" data-act="close-modal">Cancel</button>
          ${n && !sys ? `<button class="btn" data-act="dtab" data-id="users">View Users</button>` : ""}
          ${sys || !currentUser.can("role:delete") ? "" : `<button class="btn btn-danger" data-act="del-go" ${state.saving ? "disabled" : ""}>${state.saving ? "Deleting…" : "Delete"}</button>`}
        </div>
      </div></div>`
    );
  }

export function uniqueName(name) {
    return (state.data.roles || []).some((r) => r.name.toLowerCase() === name.trim().toLowerCase());
  }

export function readWizardInputs() {
    const name = $("#w-name")?.value ?? state.wizard.name;
    const description = $("#w-desc")?.value ?? state.wizard.description;
    const organizationId = $("#w-org")?.value ?? state.wizard.organizationId;
    state.wizard.name = name;
    state.wizard.description = description;
    state.wizard.organizationId = organizationId;
  }

