/* App shell — top-level layout chrome, the login screen, and ALL DOM event
   wiring (click/input/change/keydown/submit). This file intentionally stays
   large: it's the router + controller layer, exactly mirroring app.js's
   original architecture, where Roles Setup (data-act attributes, handled
   inline right here) and every other identity-org screen (data-wf
   attributes, handled by IdentityOrg.handle()) are both driven from the
   same five listeners. Splitting the listeners themselves apart would mean
   duplicating the tricky bits (caret-position-preserving search inputs,
   drawer close-screen mapping) across files for no real benefit — see
   roles.js's own header comment for the reasoning behind this split. */
import { Api } from '../core/api.js';
import { $, esc, errMsg } from '../core/dom.js';
import { setRerender } from './rerender.js';
import { setToastImpl, toast } from './toast.js';
import { state, currentUser, emptyWizard } from './state.js';
import { currentUserPermissions } from './current-user.js';
import * as IdentityOrg from '../modules/identity-org/index.js';
import {
  role, filteredRoles, orgName, loadRoles, uniqueName,
  readWizardInputs, listScreen, deleteModal, editDrawer, duplicateModal,
  assignDrawer, detail, loadPermissionsCatalog,
  createBasic, createPerms, createScope, createReview,
} from '../modules/identity-org/roles/roles.js';
import { NAV, GROUP_OF, LEAF_SCREEN, metaFor } from '../modules/identity-org/nav.js';
import { loadOrgUnits as loadOrgUnitsShared } from '../modules/identity-org/shared/loaders.js';
import * as ForecastingScheduling from '../modules/forecasting-scheduling/index.js';
import * as IntegrationHub from '../modules/integration-hub/index.js';
import { currentUserIsPlatformAdmin } from './current-user.js';

/* Two consoles share this one shell/router: the identity-org module (Modules
   01+02) and the newer Forecasting & Scheduling module. Both expose the same
   {NAV, GROUP_OF, LEAF_SCREEN, render, handle} shape, so the shell drives
   either one generically off state.module — see MODULES below. */
/* Tenant Monitoring (internal, platform_admin-only) is NOT a module here —
   platform_admin is an exclusive mode handled entirely by
   platform-admin-shell.js, routed to by app/main.js before this file is
   even imported. This shell only ever mounts for a non-platform_admin
   session, so it only ever needs the tenant-facing modules. */
const MODULES = {
  "user-management": { label: "User Management", nav: NAV, groupOf: GROUP_OF, leafScreen: LEAF_SCREEN, mod: IdentityOrg },
  "forecasting-scheduling": {
    label: "Forecasting and Scheduling",
    nav: ForecastingScheduling.NAV,
    groupOf: ForecastingScheduling.GROUP_OF,
    leafScreen: ForecastingScheduling.LEAF_SCREEN,
    mod: ForecastingScheduling,
  },
  "integration-hub": {
    label: "Integration Management",
    nav: IntegrationHub.NAV,
    groupOf: IntegrationHub.GROUP_OF,
    leafScreen: IntegrationHub.LEAF_SCREEN,
    mod: IntegrationHub,
  },
};
const activeModule = () => MODULES[state.module] || MODULES["user-management"];

const app = document.getElementById("app");

/* Real toast implementation — every other module just calls toast(msg)
   from app/toast.js, which forwards here once this is registered below. */
function realToast(msg) {
  state.toast = msg;
  render();
  setTimeout(() => {
    state.toast = null;
    render();
  }, 2600);
}
setToastImpl(realToast);
setRerender(() => render());

  function go(screen, extra = {}) {
    Object.assign(state, extra, { screen, menu: null });
    if (screen.startsWith("create") && extra.resetWizard) {
      state.wizard = emptyWizard();
    }
    render();
  }

  async function loadMe() {
    try {
      const data = await Api.gqlFetch(`query { me { email givenName familyName } }`);
      state.me = data.me;
      render();
    } catch {
      /* non-fatal — top bar just shows the JWT-decoded fallback */
    }
  }

  function shell(inner) {
    const m = activeModule();
    const groups = Object.keys(m.nav);
    return `
      <div class="app">
        <aside class="rail" aria-label="Product navigation">
          <div class="brand"><span class="mark">A</span> AGNO WFM</div>
          <div class="tenant-chip"><b>Acme Demo Corp</b>Enterprise</div>
          <div class="nav-mod-switch">
            ${Object.entries(MODULES)
              .map(
                ([key, mm]) => `
              <button class="nav-mod nav-mod-btn ${state.module === key ? "active" : ""}" data-act="switch-module" data-id="${key}">${mm.label}</button>`
              )
              .join("")}
          </div>
          ${groups
            .map(
              (g) => `
            <button class="nav-item ${state.group === g ? "active" : ""}" data-act="group" data-id="${g}">
              <span class="dot"></span>${g}
            </button>`
            )
            .join("")}
          <div class="rail-foot">Operator session</div>
        </aside>
        <div class="work">
          <header class="topbar">
            <nav class="crumbs" aria-label="Breadcrumb">
              <span>${m.label}</span><span class="sep">/</span>
              <span>${state.group}</span><span class="sep">/</span>
              <b>${(m.nav[state.group] || []).find((t) => t.id === state.tab)?.label || ""}</b>
            </nav>
            <div class="who"><span>${esc(currentUser.name)}</span><span class="avatar">${esc(currentUser.initials)}</span><button class="btn btn-sm" data-act="logout">Sign out</button></div>
          </header>
          <div class="ia">
            <div class="ia-groups" role="tablist" aria-label="${m.label}">
              ${groups
                .map(
                  (g) => `<button class="ia-group ${state.group === g ? "active" : ""}" data-act="group" data-id="${g}">${g}</button>`
                )
                .join("")}
            </div>
            <div class="ia-tabs" role="tablist" aria-label="${state.group}">
              ${(m.nav[state.group] || [])
                .map(
                  (t) =>
                    `<button class="ia-tab ${t.id === state.tab ? "active" : ""} ${t.live ? "" : "dead"}" ${
                      t.live ? `data-act="tab" data-id="${t.id}"` : "disabled title=\"Not built yet\""
                    }>${t.label}</button>`
                )
                .join("")}
            </div>
          </div>
          <main id="main" class="main">${inner}</main>
        </div>
      </div>
      ${state.toast ? `<div class="toast" role="status">${esc(state.toast)}</div>` : ""}
    `;
  }

  function renderLoginScreen(error) {
    return `
      <div class="login-wrap">
        <form id="login-form" class="login-card">
          <div class="brand" style="justify-content:center;background:none;border:0;color:var(--ink);height:auto;padding:0 0 18px">
            <span class="mark">A</span> AGNO WFM
          </div>
          <h1 style="font-size:16px;margin:0 0 4px">Sign in</h1>
          <p class="muted" style="margin:0 0 16px">User Management console</p>
          <div class="field"><label>Email or username</label>
            <input type="text" id="login-username" autocomplete="username" placeholder="admin@acme-demo.example" required />
          </div>
          <div class="field" style="margin-top:10px"><label>Password</label>
            <input type="password" id="login-password" autocomplete="current-password" placeholder="ChangeMe123!" required />
          </div>
          ${error ? `<div class="callout danger" style="margin-top:12px">${esc(error)}</div>` : ""}
          <button class="btn btn-primary" type="submit" style="width:100%;justify-content:center;margin-top:16px">Sign in</button>
          <p class="hint" style="margin-top:12px">Local dev demo tenant admin: admin@acme-demo.example / ChangeMe123!</p>
        </form>
      </div>`;
  }

  function inner() {
    if (state.module === "forecasting-scheduling") {
      return ForecastingScheduling.render(state) || `<div class="panel"><div class="empty"><h2>Select a section</h2></div></div>`;
    }
    if (state.module === "integration-hub") {
      return IntegrationHub.render(state) || `<div class="panel"><div class="empty"><h2>Select a section</h2></div></div>`;
    }
    if (
      IdentityOrg &&
      state.tab &&
      state.tab !== "roles" &&
      !String(state.screen || "").startsWith("create") &&
      !String(state.screen || "").startsWith("detail") &&
      !["list", "assign", "duplicate", "edit", "delete"].includes(state.screen)
    ) {
      const wfHtml = IdentityOrg.render(state);
      if (wfHtml) return wfHtml;
    }
    if (IdentityOrg && ["profiles", "groups", "prefs", "timeoff", "skills", "rules", "interactions", "staffing", "selfid", "usernames", "uar", "emp-detail"].includes(state.screen)) {
      const wfHtml = IdentityOrg.render(state);
      if (wfHtml) return wfHtml;
    }
    switch (state.screen) {
      case "create-basic":
        return createBasic();
      case "create-perms":
        return createPerms();
      case "create-scope":
        return createScope();
      case "create-review":
        return createReview();
      case "detail-overview":
        return detail("overview");
      case "detail-perms":
        return detail("permissions");
      case "detail-users":
        return detail("users");
      case "assign":
        return assignDrawer();
      case "duplicate":
        return duplicateModal();
      case "edit":
        return editDrawer();
      case "delete":
        return deleteModal();
      default:
        return listScreen();
    }
  }

  /**
   * Audit gap-fix (Navigation, LOW): this was a pure in-memory single-page
   * app with no URL reflection at all - refreshing the browser always
   * dropped back to the default tab (Roles Setup), losing the admin's
   * place. Full deep-linking (drawers, wizard steps, selected row) is out
   * of scope for this fix - `history.replaceState` (not `pushState`) syncs
   * just the top-level tab into the hash on every render, so refresh/close-
   * reopen restores at least the *page* you were on, without adding a
   * history-back-button entry per render or a real router.
   */
  function syncHashToState() {
    const desired = `#${state.module}/${state.tab}`;
    if (location.hash !== desired) {
      history.replaceState(null, '', desired);
    }
  }

  function restoreStateFromHash() {
    const raw = location.hash.replace(/^#/, '');
    const [modKey, tab] = raw.includes('/') ? raw.split('/') : ['user-management', raw];
    const m = MODULES[modKey];
    if (m && tab && m.nav[m.groupOf[tab]]?.some((t) => t.id === tab)) {
      state.module = modKey;
      state.tab = tab;
      state.group = m.groupOf[tab];
      state.screen = m.leafScreen[tab] || tab;
    }
  }

  function render() {
    app.innerHTML = shell(inner());
    syncHashToState();
  }

  async function ensureRolesLoaded() {
    if (!state.data.roles && !state.loading) await loadRoles();
  }
  async function ensurePermissionsLoaded() {
    if (!state.data.permissions) {
      state.data.permissions = await loadPermissionsCatalog();
      render();
    }
  }
  async function ensureOrgUnitsLoaded() {
    if (!state.data.orgUnits) {
      await loadOrgUnitsShared(state);
      render();
    }
  }

  /* A scrim (.drawer-scrim/.modal-scrim) wraps its own dialog box and both
     carry the same "close" data-wf/data-act as their Cancel button, so that
     clicking the backdrop closes it. But with delegation via closest(), a
     click on a *descendant* with no data-wf/data-act of its own (a bare
     text input, blank space in the dialog) would otherwise bubble up and
     wrongly match the scrim's "close" attribute too, closing the dialog
     out from under the user's cursor while they're just clicking into a
     field. Guard: only honor a scrim match when the click landed directly
     on the scrim element itself, not a bubbled descendant match. */
  const isUnwantedScrimMatch = (matchEl, targetEl) =>
    matchEl && targetEl !== matchEl && (matchEl.classList.contains("drawer-scrim") || matchEl.classList.contains("modal-scrim"));

  app.addEventListener("click", (e) => {
    let wfEl = e.target.closest("[data-wf]");
    if (isUnwantedScrimMatch(wfEl, e.target)) wfEl = null;
    if (wfEl) {
      e.preventDefault();
      const act = wfEl.dataset.wf;
      if (act === "toast") {
        toast(wfEl.dataset.msg || "Noted");
        if (wfEl.closest(".drawer")) state.drawer = null;
        render();
        return;
      }
      if (activeModule().mod.handle(state, act, wfEl.dataset.id, wfEl.value)) {
        render();
        return;
      }
    }
    let t = e.target.closest("[data-act]");
    if (isUnwantedScrimMatch(t, e.target)) t = null;
    if (!t) {
      if (state.menu) {
        state.menu = null;
        render();
      }
      return;
    }
    const act = t.dataset.act;
    const id = t.dataset.id;
    e.preventDefault();

    if (act === "logout") {
      Api.logout();
      app.innerHTML = renderLoginScreen();
      return;
    }

    if (act === "switch-module") {
      if (state.module !== id && MODULES[id]) {
        state.module = id;
        MODULES[id].mod.handle(state, "group-live", Object.keys(MODULES[id].nav)[0]);
      }
      render();
      return;
    }
    if (act === "group") {
      activeModule().mod.handle(state, "group-live", id);
      render();
      return;
    }
    if (act === "tab") {
      if (state.module === "user-management" && id === "roles") {
        state.tab = "roles";
        state.group = "Security";
        go("list");
        ensureRolesLoaded();
        return;
      }
      if (activeModule().mod.handle(state, "tab", id)) {
        render();
        return;
      }
    }
    if (act === "search") return;
    if (act === "create") {
      if (!currentUser.can("role:write")) return toast("Missing role:write");
      go("create-basic", { resetWizard: true });
      ensurePermissionsLoaded();
      ensureOrgUnitsLoaded();
      return;
    }
    if (act === "refresh") {
      loadRoles();
      return;
    }
    if (act === "retry") {
      loadRoles();
      return;
    }
    if (act === "export") {
      const rows = filteredRoles();
      Api.downloadCsv(
        "roles.csv",
        rows,
        [
          { label: "Name", value: "name" },
          { label: "Description", value: "description" },
          { label: "Status", value: "status" },
          { label: "Default", value: (r) => r.isDefault },
          { label: "Owner Org", value: (r) => orgName(r.organizationId) },
          { label: "Users", value: "_userCount" },
          { label: "Updated", value: "updatedAt" },
        ]
      );
      toast("Exported roles.csv (client-side — no export API).");
      return;
    }
    if (act === "toggle-filters") {
      state.filterOpen = !state.filterOpen;
      render();
      return;
    }
    if (act === "apply-filters") {
      state.filters = {
        defaultRole: $("#f-defaultRole")?.value || "",
        org: $("#f-org")?.value || "",
        status: $("#f-status")?.value || "",
        module: $("#f-module")?.value || "",
        users: $("#f-users")?.value || "",
      };
      state.filterOpen = false;
      render();
      return;
    }
    if (act === "clear-filters") {
      state.filters = { defaultRole: "", org: "", status: "", module: "", users: "" };
      render();
      return;
    }
    if (act === "chip-x") {
      state.filters[id] = "";
      render();
      return;
    }
    if (act === "sort") {
      if (state.sort.key === id) state.sort.dir *= -1;
      else state.sort = { key: id, dir: 1 };
      render();
      return;
    }
    if (act === "sel") {
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      render();
      return;
    }
    if (act === "sel-all") {
      filteredRoles().forEach((r) => state.selected.add(r.id));
      render();
      return;
    }
    if (act === "menu") {
      state.menu = state.menu === id ? null : id;
      render();
      return;
    }
    if (act === "open") {
      state.roleId = id;
      go("detail-overview");
      ensurePermissionsLoaded();
      ensureOrgUnitsLoaded();
      return;
    }
    if (act === "edit") {
      state.roleId = id || state.roleId;
      state.edit = {};
      go("edit");
      return;
    }
    if (act === "dup") {
      state.roleId = id || state.roleId;
      const r = role(state.roleId);
      state.dup = { name: r.name + " copy", description: r.description || "", copyPerms: true };
      go("duplicate");
      return;
    }
    if (act === "assign") {
      state.roleId = id || state.roleId;
      state.assign.selected = new Set();
      go("assign");
      ensureOrgUnitsLoaded();
      return;
    }
    if (act === "delete") {
      state.roleId = id || state.roleId;
      go("delete");
      return;
    }
    if (act === "toggle-status") {
      const r = role(id);
      if (!r) return;
      const newStatus = r.status === "active" ? "disabled" : "active";
      Api.rootApi(`/v1/roles/${id}`, { method: "PATCH", body: { status: newStatus } })
        .then(() => {
          r.status = newStatus;
          toast(newStatus === "disabled" ? "Role disabled." : "Role activated.");
          render();
        })
        .catch((err) => toast(errMsg(err)));
      state.menu = null;
      render();
      return;
    }
    if (act === "bulk-clear-selection") {
      state.selected.clear();
      render();
      return;
    }
    if (act === "bulk-enable" || act === "bulk-disable") {
      const newStatus = act === "bulk-enable" ? "active" : "disabled";
      const targets = [...state.selected].map((rid) => role(rid)).filter((r) => r && !r.isSystemRole && r.status !== newStatus);
      if (targets.length === 0) {
        toast("Nothing to change — selection is empty, already in that state, or system-role-only.");
        return;
      }
      Promise.allSettled(
        targets.map((r) => Api.rootApi(`/v1/roles/${r.id}`, { method: "PATCH", body: { status: newStatus } }).then(() => { r.status = newStatus; })),
      ).then((results) => {
        const failed = results.filter((res) => res.status === "rejected").length;
        toast(
          failed > 0
            ? `${targets.length - failed} of ${targets.length} role(s) updated — ${failed} failed.`
            : `${targets.length} role(s) ${newStatus === "disabled" ? "disabled" : "activated"}.`,
        );
        render();
      });
      return;
    }
    if (act === "close-drawer" || act === "close-modal") {
      const back = {
        "create-basic": "list",
        "create-perms": "list",
        "create-scope": "list",
        "create-review": "list",
        assign: "detail-users",
        edit: "detail-overview",
        duplicate: "list",
        delete: "list",
      };
      go(back[state.screen] || "list");
      return;
    }
    if (act === "wiz-back") {
      readWizardInputs();
      const map = { 2: "create-basic", 3: "create-perms", 4: "create-scope" };
      state.wizard.step -= 1;
      go(map[state.wizard.step + 1]);
      return;
    }
    if (act === "wiz-next") {
      readWizardInputs();
      if (state.wizard.step === 1) {
        if (!state.wizard.name.trim()) {
          state.wizard.nameError = "Role name is required.";
          render();
          return;
        }
        if (uniqueName(state.wizard.name)) {
          state.wizard.nameError = "Role name already exists.";
          render();
          return;
        }
        state.wizard.nameError = "";
        state.wizard.step = 2;
        go("create-perms");
        return;
      }
      if (state.wizard.step === 2) {
        state.wizard.step = 3;
        go("create-scope");
        return;
      }
      if (state.wizard.step === 3) {
        state.wizard.step = 4;
        go("create-review");
        return;
      }
    }
    if (act === "tog-default") {
      state.wizard.isDefault = !state.wizard.isDefault;
      render();
      return;
    }
    if (act === "ed-tog-default") {
      state.edit.isDefault = !(state.edit.isDefault ?? role(state.roleId).isDefault);
      render();
      return;
    }
    if (act === "st-active") {
      state.wizard.status = "active";
      render();
      return;
    }
    if (act === "st-disabled") {
      state.wizard.status = "disabled";
      render();
      return;
    }
    if (act === "perm-group") {
      state.permGroup = id;
      render();
      return;
    }
    if (act === "tog-perm") {
      if (t.getAttribute("aria-disabled") === "true") return;
      const inWizard = state.screen.startsWith("create");
      const set = inWizard ? state.wizard.perms : new Set(role(state.roleId)._permissionIds);
      const willBind = !set.has(id);
      if (inWizard) {
        if (willBind) set.add(id);
        else set.delete(id);
        render();
        return;
      }
      // detail-perms: real bind/unbind immediately
      const r = role(state.roleId);
      const call = willBind
        ? Api.rootApi(`/v1/roles/${r.id}/permissions`, { method: "POST", body: { permissionId: id } })
        : Api.rootApi(`/v1/roles/${r.id}/permissions/${id}`, { method: "DELETE" });
      call
        .then(() => {
          if (willBind) r._permissionIds.push(id);
          else r._permissionIds = r._permissionIds.filter((x) => x !== id);
          render();
        })
        .catch((err) => toast(errMsg(err)));
      return;
    }
    if (act === "sel-all-perm") {
      (state.data.permissions || []).forEach((p) => state.wizard.perms.add(p.id));
      render();
      return;
    }
    if (act === "clr-all-perm") {
      state.wizard.perms.clear();
      render();
      return;
    }
    if (act === "sel-mod") {
      (state.data.permissions || [])
        .filter((p) => metaFor(p.resource).group === state.permGroup)
        .forEach((p) => state.wizard.perms.add(p.id));
      render();
      return;
    }
    if (act === "clr-mod") {
      (state.data.permissions || [])
        .filter((p) => metaFor(p.resource).group === state.permGroup)
        .forEach((p) => state.wizard.perms.delete(p.id));
      render();
      return;
    }
    if (act === "sel-only") {
      state.permSelectedOnly = !state.permSelectedOnly;
      render();
      return;
    }
    if (act === "scope-tenant") {
      state.wizard.scope = "tenant";
      render();
      return;
    }
    if (act === "scope-ou") {
      state.wizard.scope = "ou";
      render();
      return;
    }
    if (act === "pick-ou") {
      state.wizard.scopeOu = id;
      render();
      return;
    }
    if (act === "wiz-create") {
      if (!currentUser.can("role:write")) return toast("Missing role:write");
      state.saving = true;
      render();
      const w = state.wizard;
      Api.rootApi("/v1/roles", {
        method: "POST",
        body: {
          name: w.name.trim(),
          description: w.description || undefined,
          organizationId: w.organizationId || undefined,
          isDefault: w.isDefault,
          status: w.status,
        },
      })
        .then(async (created) => {
          await Promise.all(
            [...w.perms].map((permissionId) => Api.rootApi(`/v1/roles/${created.id}/permissions`, { method: "POST", body: { permissionId } }))
          );
          state.saving = false;
          await loadRoles();
          state.roleId = created.id;
          toast("Role created.");
          go("detail-overview");
        })
        .catch((err) => {
          state.saving = false;
          toast(errMsg(err));
          render();
        });
      return;
    }
    if (act === "dtab") {
      const map = { overview: "detail-overview", permissions: "detail-perms", users: "detail-users" };
      go(map[id] || "detail-overview");
      return;
    }
    if (act === "as-tog") {
      if (state.assign.selected.has(id)) state.assign.selected.delete(id);
      else state.assign.selected.add(id);
      render();
      return;
    }
    if (act === "as-scope-t") {
      state.assign.scope = "tenant";
      render();
      return;
    }
    if (act === "as-scope-o") {
      state.assign.scope = "ou";
      render();
      return;
    }
    if (act === "as-ou") {
      state.assign.scopeOu = id;
      render();
      return;
    }
    if (act === "as-go") {
      const r = role(state.roleId);
      const scopeOrgUnitId = state.assign.scope === "ou" ? state.assign.scopeOu || null : null;
      state.saving = true;
      render();
      const ids = [...state.assign.selected];
      Promise.all(
        ids.map((userId) => Api.rootApi(`/v1/users/${userId}/roles`, { method: "POST", body: { roleId: r.id, scopeOrgUnitId } }))
      )
        .then(async () => {
          state.saving = false;
          delete state.roleUsers[r.id];
          const count = await Api.rootApi(`/v1/roles/${r.id}/user-count`);
          r._userCount = count.count;
          toast(`Assigned ${ids.length} user(s).`);
          go("detail-users");
        })
        .catch((err) => {
          state.saving = false;
          toast(errMsg(err));
          render();
        });
      return;
    }
    if (act === "revoke") {
      const r = role(state.roleId);
      const scope = t.dataset.scope || "";
      const q = scope ? `?scopeOrgUnitId=${encodeURIComponent(scope)}` : "";
      Api.rootApi(`/v1/users/${id}/roles/${r.id}${q}`, { method: "DELETE" })
        .then(async () => {
          delete state.roleUsers[r.id];
          const count = await Api.rootApi(`/v1/roles/${r.id}/user-count`);
          r._userCount = count.count;
          toast("User removed from role.");
          render();
        })
        .catch((err) => toast(errMsg(err)));
      return;
    }
    if (act === "dup-p") {
      state.dup.copyPerms = !state.dup.copyPerms;
      render();
      return;
    }
    if (act === "dup-go") {
      const name = $("#dup-name")?.value.trim();
      const desc = $("#dup-desc")?.value || "";
      if (!name) return toast("New role name is required.");
      if (uniqueName(name)) return toast("Role name already exists.");
      const src = role(state.roleId);
      state.saving = true;
      render();
      Api.rootApi("/v1/roles", {
        method: "POST",
        body: { name, description: desc || undefined, organizationId: src.organizationId || undefined, isDefault: false, status: "active" },
      })
        .then(async (created) => {
          if (state.dup.copyPerms) {
            await Promise.all(
              (src._permissionIds || []).map((permissionId) =>
                Api.rootApi(`/v1/roles/${created.id}/permissions`, { method: "POST", body: { permissionId } })
              )
            );
          }
          state.saving = false;
          await loadRoles();
          state.roleId = created.id;
          toast("Duplicated. Users were not copied.");
          go("detail-overview");
        })
        .catch((err) => {
          state.saving = false;
          toast(errMsg(err));
          render();
        });
      return;
    }
    if (act === "edit-save") {
      const r = role(state.roleId);
      const name = $("#ed-name")?.value.trim();
      const description = $("#ed-desc")?.value;
      const organizationId = $("#ed-org")?.value;
      if (!name) return toast("Role name is required.");
      state.saving = true;
      render();
      Api.rootApi(`/v1/roles/${r.id}`, {
        method: "PATCH",
        body: { name, description, organizationId: organizationId || null, isDefault: state.edit.isDefault ?? r.isDefault },
      })
        .then((updated) => {
          Object.assign(r, updated);
          state.saving = false;
          toast("Role updated.");
          go("detail-overview");
        })
        .catch((err) => {
          state.saving = false;
          toast(errMsg(err));
          render();
        });
      return;
    }
    if (act === "del-go") {
      const r = role(state.roleId);
      state.saving = true;
      render();
      Api.rootApi(`/v1/roles/${r.id}`, { method: "DELETE" })
        .then(() => {
          state.data.roles = state.data.roles.filter((x) => x.id !== r.id);
          state.saving = false;
          toast("Role deleted.");
          go("list");
        })
        .catch((err) => {
          state.saving = false;
          toast(errMsg(err));
          render();
        });
      return;
    }
  });

  app.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.wf) {
      const act = t.dataset.wf;
      if (["emp-search", "user-search", "sid-search", "cal-search"].includes(act)) {
        activeModule().mod.handle(state, act, t.dataset.id, t.value);
        const pos = t.selectionStart;
        render();
        const el = document.querySelector(`[data-wf="${act}"]`);
        if (el) {
          el.focus();
          try {
            el.setSelectionRange(pos, pos);
          } catch {}
        }
        return;
      }
    }
    if (t.dataset.act === "search") {
      state.search = t.value;
      render();
      const el = $(`[data-act="search"]`);
      if (el) {
        el.value = state.search;
        el.focus();
        try {
          el.setSelectionRange(state.search.length, state.search.length);
        } catch {}
      }
    }
    if (t.dataset.act === "perm-search") {
      state.permSearch = t.value;
      const pos = t.selectionStart;
      render();
      const el = $(`[data-act="perm-search"]`);
      if (el) {
        el.focus();
        try {
          el.setSelectionRange(pos, pos);
        } catch {}
      }
    }
    if (t.dataset.act === "as-search") {
      state.assign.search = t.value;
      const pos = t.selectionStart;
      render();
      const el = $(`[data-act="as-search"]`);
      if (el) {
        el.focus();
        try {
          el.setSelectionRange(pos, pos);
        } catch {}
      }
    }
  });

  app.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.wf) {
      if (activeModule().mod.handle(state, t.dataset.wf, t.dataset.id, t.value)) {
        /* Deferred, not synchronous: a "change" on a text field fires as a
           side effect of blur, which itself fires synchronously during
           mousedown when the user's very next action is clicking a
           DIFFERENT element (e.g. a drawer's Save button right after
           typing the last field). A synchronous render() here replaces
           app.innerHTML mid-gesture, detaching that button from the
           document before the browser dispatches its own click event —
           Chromium then silently drops the click entirely (reproduced:
           zero click-handler invocation, not just a stale reference).
           Deferring by one macrotask lets the current native event
           sequence (blur -> change -> mouseup -> click) finish dispatching
           against the still-live DOM first. */
        setTimeout(render, 0);
        return;
      }
    }
    if (t.id === "as-org") {
      state.assign.org = t.value;
      render();
    }
    if (t.id === "as-st") {
      state.assign.status = t.value;
      render();
    }
  });

  app.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.menu) {
        state.menu = null;
        render();
      }
    }
  });

  app.addEventListener("submit", async (e) => {
    if (!e.target || e.target.id !== "login-form") return;
    e.preventDefault();
    const username = $("#login-username")?.value.trim() || "";
    const password = $("#login-password")?.value || "";
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      await Api.login(username, password);
      /* platform_admin is an exclusive mode owned by platform-admin-shell.js,
         not a module inside this shell (see app/main.js) — a fresh login
         that turns out to belong to one hands off via a full reload, so
         main.js's own isAuthenticated()+role check routes to that shell
         instead of this one rendering the tenant-facing UI underneath it. */
      if (currentUserIsPlatformAdmin()) {
        location.reload();
        return;
      }
      currentUser.permissions = currentUserPermissions();
      loadMe();
      render();
      if (state.tab === "roles") ensureRolesLoaded();
    } catch (err) {
      app.innerHTML = renderLoginScreen(errMsg(err));
    }
  });

  export function boot() {
    if (Api && Api.isAuthenticated()) {
      restoreStateFromHash();
      render();
      loadMe();
      if (state.tab === "roles") ensureRolesLoaded();
    } else {
      app.innerHTML = renderLoginScreen();
    }
  }

