/* Top-level shell for the internal, platform_admin-only console — the
   counterpart to shell.js (the tenant-facing product shell), but a
   deliberately separate file: platform_admin is an exclusive mode (see
   current-user.js's currentUserIsPlatformAdmin doc comment), routed to by
   app/main.js, not a module living inside shell.js's own MODULES registry.
   Neither file imports the other.

   Only ever booted once app/main.js has already confirmed
   Api.isAuthenticated() and currentUserIsPlatformAdmin() — this file
   assumes both are true and never renders a login screen of its own.
   Today this only wires up the Tenant Monitoring module (Onboarding
   Funnel / Tenant Health); a future second platform-admin-only module
   (e.g. Tenant Provisioning) would be added here the same way
   shell.js grew past its first module — no registry abstraction yet,
   since there's exactly one entry to register today. */
import { Api } from '../core/api.js';
import { esc } from '../core/dom.js';
import { setRerender } from './rerender.js';
import { setToastImpl } from './toast.js';
import { state, currentUser } from './state.js';
import { currentUserPermissions } from './current-user.js';
import * as TenantMonitoring from '../modules/tenant-monitoring/index.js';

const app = document.getElementById('app');

function realToast(msg) {
  state.toast = msg;
  render();
  setTimeout(() => {
    state.toast = null;
    render();
  }, 2600);
}

function ensureTenantMonitoringTab() {
  if (!TenantMonitoring.GROUP_OF[state.tab]) {
    state.tab = TenantMonitoring.FIRST[Object.keys(TenantMonitoring.NAV)[0]];
    state.group = TenantMonitoring.GROUP_OF[state.tab];
    state.screen = TenantMonitoring.LEAF_SCREEN[state.tab];
  }
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
  const groups = Object.keys(TenantMonitoring.NAV);
  return `
    <div class="app">
      <aside class="rail" aria-label="Platform admin navigation">
        <div class="brand"><span class="mark">A</span> AGNO WFM</div>
        <div class="tenant-chip"><b>Platform Admin</b>Cross-tenant console</div>
        ${groups
          .map(
            (g) => `
          <button class="nav-item ${state.group === g ? 'active' : ''}" data-act="group" data-id="${g}">
            <span class="dot"></span>${g}
          </button>`
          )
          .join('')}
        <div class="rail-foot">Platform admin session</div>
      </aside>
      <div class="work">
        <header class="topbar">
          <nav class="crumbs" aria-label="Breadcrumb">
            <span>Tenant Monitoring</span><span class="sep">/</span>
            <span>${state.group}</span><span class="sep">/</span>
            <b>${(TenantMonitoring.NAV[state.group] || []).find((t) => t.id === state.tab)?.label || ''}</b>
          </nav>
          <div class="who"><span>${esc(currentUser.name)}</span><span class="avatar">${esc(currentUser.initials)}</span><button class="btn btn-sm" data-act="logout">Sign out</button></div>
        </header>
        <div class="ia">
          <div class="ia-groups" role="tablist" aria-label="Tenant Monitoring">
            ${groups
              .map(
                (g) => `<button class="ia-group ${state.group === g ? 'active' : ''}" data-act="group" data-id="${g}">${g}</button>`
              )
              .join('')}
          </div>
          <div class="ia-tabs" role="tablist" aria-label="${state.group}">
            ${(TenantMonitoring.NAV[state.group] || [])
              .map(
                (t) =>
                  `<button class="ia-tab ${t.id === state.tab ? 'active' : ''}" data-act="tab" data-id="${t.id}">${t.label}</button>`
              )
              .join('')}
          </div>
        </div>
        <main id="main" class="main">${inner}</main>
      </div>
    </div>
    ${state.toast ? `<div class="toast" role="status">${esc(state.toast)}</div>` : ''}
  `;
}

function render() {
  ensureTenantMonitoringTab();
  app.innerHTML = shell(TenantMonitoring.render(state) || '');
}

app.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  e.preventDefault();
  const act = t.dataset.act;
  const id = t.dataset.id;

  if (act === 'logout') {
    Api.logout();
    location.reload();
    return;
  }
  if (act === 'group') {
    TenantMonitoring.handle(state, 'group-live', id);
    render();
    return;
  }
  if (act === 'tab') {
    TenantMonitoring.handle(state, 'tab', id);
    render();
    return;
  }
  if (TenantMonitoring.handle(state, act, id, t.value)) {
    render();
  }
});

/* Field capture for the All Tenants create/provision-admin drawers — same
   data-wf convention app/shell.js uses for its own "change" listener, and
   for the same reason: a value must land in state as the user edits it,
   not be read from a plain uncaptured input at submit time, because this
   drawer's own async analytics load (all-tenants.js's ensureAnalyticsLoaded)
   can trigger a re-render — which replaces every input's DOM node — while
   the user is still filling the form out. Reproduced, not hypothetical:
   without this, a re-render landing mid-edit silently wiped the Provision
   Admin form before the request ever fired, caught while testing this
   drawer live.

   Deferred via setTimeout, not a synchronous render() — same fix and same
   reason shell.js's own "change" listener documents: "change" fires as a
   side effect of blur, which fires synchronously during mousedown when the
   very next action is clicking a different element (e.g. this drawer's own
   Create/Provision button right after typing the last field). A
   synchronous render() here replaces app.innerHTML mid-gesture, detaching
   that button before the browser dispatches its own click — reproduced
   here too: without the defer, the click on Provision Admin was silently
   dropped and the request never fired. */
app.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.wf && TenantMonitoring.handle(state, t.dataset.wf, t.dataset.id, t.value)) {
    setTimeout(render, 0);
  }
});

setToastImpl(realToast);
setRerender(() => render());

export function boot() {
  currentUser.permissions = currentUserPermissions();
  ensureTenantMonitoringTab();
  render();
  loadMe();
}
