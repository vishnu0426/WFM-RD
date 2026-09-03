/* Tenants > All Tenants — the platform_admin console's actual onboarding
   screen: list every tenant (root service, GET /v1/tenants/all — the one
   genuinely cross-tenant list endpoint that exists, see tenant-management.
   controller.ts), create a new one, and walk it through onboarding.

   The tenant detail drawer is an accordion checklist — Company Information
   / Primary Admin / Organization / Security / Analytics — where each
   panel's ✓/○ status is derived from real data on every render (tenant
   status, a live org-units-exist check, the health rollup's ssoConfigured
   field), never a stored "onboarding progress" flag. Security is
   read-only: SSO/security policy is the tenant's own admin's call, not
   something a platform admin sets on their behalf.

   The Onboarding Funnel / Tenant Health tabs are read-only analytics views
   sourced from a nightly-refreshed rollup; this screen is the live,
   authoritative one — a tenant/org-unit created here shows up immediately,
   even before the next rollup run reflects it in those two tabs or in this
   drawer's own Analytics panel.

   Every drawer field is captured into a draft in `state` as it changes
   (data-wf, handled by app/platform-admin-shell.js's own "change"
   listener) and always rendered FROM that draft, never read straight off
   the DOM at submit time — this screen's own async analytics/org-status
   loads can trigger a re-render (replacing every input's DOM node) while
   the user is mid-edit; an uncaptured input would silently lose its value
   the same way forecasting-scheduling/campaigns.js's own doc comment
   describes, and did in fact do so before this was fixed. */
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, empty, fmtDt, drawerShell } from '../../identity-org/shared/ui.js';
import { tenantStatusBadge } from '../tenant-status-badge.js';
import { COUNTRIES, CURRENCIES, LANGUAGES, INDUSTRIES, DATA_RESIDENCY_REGIONS } from '../reference-data.js';
import * as TenantMonitoringApi from '../api.js';

function selectOptions(pairs, selectedValue, includeBlank) {
  const blank = includeBlank ? `<option value="">—</option>` : '';
  return blank + pairs.map(([value, label]) => `<option value="${esc(value)}" ${selectedValue === value ? 'selected' : ''}>${esc(label)}</option>`).join('');
}

const TIERS = ['smb', 'enterprise', 'bpo'];
const ORG_UNIT_TYPES = ['business_unit', 'department', 'site', 'team'];
const WEEK_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

async function loadAllTenants(state) {
  state.wf.allTenants = { loading: true };
  doRerender();
  try {
    state.wf.allTenants = { tenants: await TenantMonitoringApi.listAllTenants() };
  } catch (err) {
    state.wf.allTenants = { error: errMsg(err) };
  }
  doRerender();
}

async function loadTenantDetail(state, id) {
  state.wf.tenantDetail = state.wf.tenantDetail || {};
  state.wf.tenantDetail[id] = { loading: true };
  doRerender();
  try {
    state.wf.tenantDetail[id] = { tenant: await TenantMonitoringApi.getTenant(id) };
  } catch (err) {
    state.wf.tenantDetail[id] = { error: errMsg(err) };
  }
  doRerender();
}

/* Organization accordion panel's derived status - real cross-tenant read
   (GET /v1/tenants/:id/org-units/exists), same "fired once from the
   open-tenant-detail handler, never from inside render()" discipline as
   loadTenantDetail/ensureAnalyticsLoaded. */
async function loadOrgUnitStatus(state, id) {
  state.wf.orgUnitStatus = state.wf.orgUnitStatus || {};
  state.wf.orgUnitStatus[id] = { loading: true };
  doRerender();
  try {
    state.wf.orgUnitStatus[id] = await TenantMonitoringApi.getOrgUnitStatus(id);
  } catch (err) {
    state.wf.orgUnitStatus[id] = { error: errMsg(err) };
  }
  doRerender();
}

/* WFM Configuration accordion panel's derived status - real cross-tenant
   read (GET /v1/tenants/:id/wfm-defaults), same "fired once from
   open-tenant-detail, never from inside render()" discipline as the rest
   of this file's loaders. */
async function loadWfmDefaults(state, id) {
  state.wf.wfmDefaults = state.wf.wfmDefaults || {};
  state.wf.wfmDefaults[id] = { loading: true };
  doRerender();
  try {
    state.wf.wfmDefaults[id] = { settings: await TenantMonitoringApi.getWfmDefaults(id) };
  } catch (err) {
    state.wf.wfmDefaults[id] = { error: errMsg(err) };
  }
  doRerender();
}

/* Data Sources accordion panel's derived status - real cross-tenant read
   against integration-hub-service (GET /v1/tenants/:id/connectors/exists),
   a genuinely different backend service from everything else on this
   page. Read-only - see TenantConnectorsController's own doc comment for
   why there's no create action here. */
async function loadConnectorStatus(state, id) {
  state.wf.connectorStatus = state.wf.connectorStatus || {};
  state.wf.connectorStatus[id] = { loading: true };
  doRerender();
  try {
    state.wf.connectorStatus[id] = await TenantMonitoringApi.getConnectorStatus(id);
  } catch (err) {
    state.wf.connectorStatus[id] = { error: errMsg(err) };
  }
  doRerender();
}

/* The analytics tie-in reuses whatever the Onboarding Funnel / Tenant
   Health tabs have already loaded into state.wf, rather than a third data
   source. Fired once from the open-tenant-detail handler (never from
   inside render()) — both are nightly-refreshed rollups, so a brand-new
   tenant legitimately won't be in either until the next run; that's shown
   as a fact, not an error. */
function ensureAnalyticsLoaded(state) {
  if (state.wf.tenantOnboardingFunnel === undefined) {
    state.wf.tenantOnboardingFunnel = { loading: true };
    TenantMonitoringApi.getOnboardingFunnel()
      .then((data) => { state.wf.tenantOnboardingFunnel = data; doRerender(); })
      .catch((err) => { state.wf.tenantOnboardingFunnel = { error: errMsg(err) }; doRerender(); });
  }
  if (state.wf.tenantHealth === undefined) {
    state.wf.tenantHealth = { loading: true };
    TenantMonitoringApi.getHealth()
      .then((data) => { state.wf.tenantHealth = data; doRerender(); })
      .catch((err) => { state.wf.tenantHealth = { error: errMsg(err) }; doRerender(); });
  }
}

const MILESTONE_LABELS = {
  tenant_provisioned: 'Tenant created',
  admin_provisioned: 'Admin provisioned',
  user_invited: 'Users invited',
  invite_accepted: 'Invite accepted',
  sso_configured: 'SSO/SCIM configured',
  first_login: 'First login',
};

function healthRowFor(state, tenantId) {
  const health = state.wf.tenantHealth;
  return health?.tenants?.find((h) => h.tenantId === tenantId);
}

function analyticsSection(state, tenantId) {
  const funnel = state.wf.tenantOnboardingFunnel;
  const health = state.wf.tenantHealth;
  if (funnel === undefined || health === undefined || funnel.loading || health.loading) {
    return `<div class="skel" style="height:60px"></div>`;
  }

  const funnelRow = funnel?.tenants?.find((t) => t.tenantId === tenantId);
  const healthRow = healthRowFor(state, tenantId);
  if (!funnelRow && !healthRow) {
    return `<p class="hint">Not yet reflected in analytics — the Onboarding Funnel / Tenant Health rollups refresh nightly.</p>`;
  }

  const milestones = funnelRow
    ? `<dl class="kv">${Object.entries(MILESTONE_LABELS)
        .map(([key, label]) => `<dt>${label}</dt><dd>${funnelRow.milestones[key] ? fmtDt(funnelRow.milestones[key]) : '—'}</dd>`)
        .join('')}</dl>`
    : `<p class="muted">No onboarding-milestone data yet.</p>`;

  const healthDl = healthRow
    ? `<dl class="kv">
        <dt>SSO configured</dt><dd>${healthRow.ssoConfigured ? 'Yes' : 'No'}</dd>
        <dt>Last login</dt><dd>${healthRow.lastLoginAt ? fmtDt(healthRow.lastLoginAt) : '—'}</dd>
        <dt>Days since login</dt><dd>${healthRow.daysSinceLastLogin ?? '—'}</dd>
      </dl>`
    : `<p class="muted">No health data yet.</p>`;

  return `
    <div class="grid-2">
      <div><h4>Onboarding milestones</h4>${milestones}</div>
      <div><h4>Health</h4>${healthDl}</div>
    </div>`;
}

/* Accordion panel: a clickable header (✓/○ + title + one-line derived
   status + chevron) toggling a body. Open/closed defaults to "open iff not
   done" so the next actionable step is what the admin sees first; a user
   click overrides that default via state.wf.accordionManual, keyed the
   same way state.wf.accordionEffective caches what was actually shown
   this render (read by the toggle handler to flip it — handle() has no
   other way to know the current effective state without duplicating this
   function's own done-derivation logic there too). */
function accordionPanel(state, sectionKey, title, done, statusText, bodyHtml, defaultOpen) {
  const key = `${state.tenantDetailId}:${sectionKey}`;
  state.wf.accordionManual = state.wf.accordionManual || {};
  state.wf.accordionEffective = state.wf.accordionEffective || {};
  const fallbackOpen = defaultOpen !== undefined ? defaultOpen : !done;
  const open = state.wf.accordionManual[key] === undefined ? fallbackOpen : state.wf.accordionManual[key];
  state.wf.accordionEffective[key] = open;
  return `
    <section class="sec">
      <h3 style="cursor:pointer;user-select:none" data-act="toggle-accordion" data-id="${sectionKey}">
        <span class="badge ${done ? 'badge-ok' : 'badge-sys'}">${done ? '✓' : '○'}</span> ${esc(title)}
        <span class="muted" style="font-weight:400">— ${esc(statusText)}</span>
        <span style="float:right">${open ? '▾' : '▸'}</span>
      </h3>
      ${open ? `<div class="body">${bodyHtml}</div>` : ''}
    </section>`;
}

export function render(state) {
  const cache = state.wf.allTenants;
  if (cache === undefined) loadAllTenants(state);

  const head = pageHead(
    'All Tenants',
    'Every tenant in the system — live. Create a new tenant and walk it through onboarding from here.',
    `<button class="btn btn-primary" data-act="open-create-tenant">+ Create Tenant</button>`,
  );

  if (!cache || cache.loading) {
    return `${head}<div class="panel"><div class="skel" style="height:120px"></div></div>`;
  }
  if (cache.error) {
    return `${head}<div class="panel">${empty('Could not load tenants.', cache.error)}</div>`;
  }
  if (!cache.tenants.length) {
    return `${head}<div class="panel">${empty('No tenants yet.', 'Create the first one to get started.')}</div>`;
  }

  const rows = cache.tenants
    .map(
      (t) => `
      <tr class="row-click" data-act="open-tenant-detail" data-id="${t.id}">
        <td><b>${esc(t.name)}</b></td>
        <td>${tenantStatusBadge(t.status)}</td>
        <td>${esc(t.tier)}</td>
        <td>${esc(t.dataResidencyRegion)}</td>
        <td>${fmtDt(t.createdAt)}</td>
      </tr>`,
    )
    .join('');

  return `
    ${head}
    <div class="panel">
      <div style="overflow-x:auto">
        <table class="data">
          <thead><tr><th>Tenant</th><th>Status</th><th>Tier</th><th>Region</th><th>Created</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function emptyCreateDraft() {
  return { name: '', tier: TIERS[0], dataResidencyRegion: DATA_RESIDENCY_REGIONS[0][0], slug: '', industry: '', country: '', currency: '', language: '' };
}

/* Company Information panel's body before a tenant exists yet — the
   create form itself. This is a single-submit flow: Primary Admin/
   Organization/WFM Configuration are filled in right here too (their
   panels below render the same field-only markup, unlocked), and one
   "Create & Provision Tenant" button in the drawer footer fires the
   whole sequence — create tenant, then (conditionally) provision admin,
   create org unit, and save WFM defaults — reusing each step's own
   state/handler so partial failures stay visible and retriable via the
   normal post-creation accordion buttons. */
function createFormPanelBody(state) {
  const d = state.createTenantDraft || emptyCreateDraft();
  return `
    <div class="field"><label>Name</label><input data-wf="ct-field" data-id="name" placeholder="e.g. Globex Corp" value="${esc(d.name)}" /></div>
    <div class="grid-2" style="margin-top:10px">
      <div class="field"><label>Tier</label>
        <select data-wf="ct-field" data-id="tier">${TIERS.map((t) => `<option value="${t}" ${d.tier === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Slug</label><input data-wf="ct-field" data-id="slug" placeholder="e.g. globex-corp" value="${esc(d.slug)}" /></div>
    </div>
    <div class="field" style="margin-top:10px"><label>Data residency region</label>
      <select data-wf="ct-field" data-id="dataResidencyRegion">${selectOptions(DATA_RESIDENCY_REGIONS, d.dataResidencyRegion, false)}</select>
    </div>
    <div class="grid-2" style="margin-top:10px">
      <div class="field"><label>Industry</label>
        <select data-wf="ct-field" data-id="industry">${selectOptions(INDUSTRIES.map((i) => [i, i]), d.industry, true)}</select>
      </div>
      <div class="field"><label>Country</label>
        <select data-wf="ct-field" data-id="country">${selectOptions(COUNTRIES, d.country, true)}</select>
      </div>
    </div>
    <div class="grid-2" style="margin-top:10px">
      <div class="field"><label>Currency</label>
        <select data-wf="ct-field" data-id="currency">${selectOptions(CURRENCIES, d.currency, true)}</select>
      </div>
      <div class="field"><label>Language</label>
        <select data-wf="ct-field" data-id="language">${selectOptions(LANGUAGES, d.language, true)}</select>
      </div>
    </div>`;
}

function emptyProvisionDraft() {
  return { email: '', givenName: '', familyName: '', phone: '', jobTitle: '' };
}

function emptyOrgUnitDraft() {
  return { name: '', type: ORG_UNIT_TYPES[0], timezone: '', countryCode: '' };
}

function companyPanel(t) {
  return `
    <dl class="kv">
      <dt>Status</dt><dd>${tenantStatusBadge(t.status)}</dd>
      <dt>Tier</dt><dd>${esc(t.tier)}</dd>
      <dt>Slug</dt><dd>${t.slug ? esc(t.slug) : '—'}</dd>
      <dt>Region</dt><dd>${esc(t.dataResidencyRegion)}</dd>
      <dt>Industry</dt><dd>${t.industry ? esc(t.industry) : '—'}</dd>
      <dt>Country</dt><dd>${t.country ? esc(t.country) : '—'}</dd>
      <dt>Currency</dt><dd>${t.currency ? esc(t.currency) : '—'}</dd>
      <dt>Language</dt><dd>${t.language ? esc(t.language) : '—'}</dd>
      <dt>Parent tenant</dt><dd>${t.parentTenantId ? esc(t.parentTenantId) : '—'}</dd>
      <dt>Created</dt><dd>${fmtDt(t.createdAt)}</dd>
      <dt>Updated</dt><dd>${fmtDt(t.updatedAt)}</dd>
    </dl>`;
}

/* Shared between the post-creation Primary Admin panel (its own "Provision
   admin" button) and the pre-creation checklist (fields only, no button —
   see createFormPanelBody's own doc comment for the single-submit flow). */
function adminFormFields(d) {
  return `
    <div class="field"><label>Email</label><input data-wf="pa-field" data-id="email" placeholder="admin@customer.example" value="${esc(d.email)}" /></div>
    <div class="grid-2" style="margin-top:10px">
      <div class="field"><label>Given name</label><input data-wf="pa-field" data-id="givenName" value="${esc(d.givenName)}" /></div>
      <div class="field"><label>Family name</label><input data-wf="pa-field" data-id="familyName" value="${esc(d.familyName)}" /></div>
    </div>
    <div class="grid-2" style="margin-top:10px">
      <div class="field"><label>Phone</label><input data-wf="pa-field" data-id="phone" value="${esc(d.phone)}" /></div>
      <div class="field"><label>Job title</label><input data-wf="pa-field" data-id="jobTitle" value="${esc(d.jobTitle)}" /></div>
    </div>`;
}

function adminPanel(state, id) {
  const saving = state.wf.saving?.provisionAdmin;
  const provisionResult = state.wf.provisionResult?.[id];
  const d = state.provisionAdminDraft || emptyProvisionDraft();
  if (provisionResult) {
    return `<p>Invited <b>${esc(provisionResult.user.email)}</b>. Invite expires ${fmtDt(provisionResult.expiresAt)}.</p>`;
  }
  return `
    ${adminFormFields(d)}
    <div class="actions" style="margin-top:10px">
      <button class="btn btn-primary" data-act="provision-admin-go" data-id="${id}" ${saving ? 'disabled' : ''}>${saving ? 'Provisioning…' : 'Provision admin'}</button>
    </div>`;
}

function orgFormFields(d) {
  return `
    <div class="field"><label>Name</label><input data-wf="ou-field" data-id="name" placeholder="e.g. Headquarters" value="${esc(d.name)}" /></div>
    <div class="grid-2" style="margin-top:10px">
      <div class="field"><label>Type</label>
        <select data-wf="ou-field" data-id="type">${ORG_UNIT_TYPES.map((t) => `<option value="${t}" ${d.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Timezone</label><input data-wf="ou-field" data-id="timezone" placeholder="e.g. America/New_York" value="${esc(d.timezone)}" /></div>
    </div>
    <div class="field" style="margin-top:10px;max-width:120px"><label>Country code</label><input data-wf="ou-field" data-id="countryCode" placeholder="US" maxlength="2" value="${esc(d.countryCode)}" /></div>`;
}

function orgPanel(state, id, orgStatus) {
  if (!orgStatus || orgStatus.loading) return `<div class="skel" style="height:40px"></div>`;
  if (orgStatus.error) return `<p class="muted">${esc(orgStatus.error)}</p>`;
  if (orgStatus.hasOrgUnits) return `<p class="muted">This tenant already has at least one organization unit.</p>`;
  const d = state.orgUnitDraft || emptyOrgUnitDraft();
  const saving = state.wf.saving?.createOrgUnit;
  return `
    ${orgFormFields(d)}
    <div class="actions" style="margin-top:10px">
      <button class="btn btn-primary" data-act="create-org-unit-go" data-id="${id}" ${saving ? 'disabled' : ''}>${saving ? 'Creating…' : 'Create organization'}</button>
    </div>`;
}

function securityPanel(state, id, healthLoading, healthRow) {
  if (healthLoading) return `<div class="skel" style="height:30px"></div>`;
  return healthRow?.ssoConfigured
    ? `<p>SSO/SCIM is configured for this tenant.</p>`
    : `<p class="muted">Not yet configured — the tenant's own admin configures SSO after logging in.</p>`;
}

function dataSourcesPanel(connectorStatus) {
  if (!connectorStatus || connectorStatus.loading) return `<div class="skel" style="height:30px"></div>`;
  if (connectorStatus.error) return `<p class="muted">${esc(connectorStatus.error)}</p>`;
  return connectorStatus.hasConnectors
    ? `<p>This tenant has at least one data source connector configured.</p>`
    : `<p class="muted">No data source connectors yet. Connector creation requires real credentials, so it's a
        <b>BACKEND GAP</b> for this onboarding step — the tenant's own admin connects one after logging in
        (Integrations screen), not platform_admin.</p>`;
}

function emptyWfmDraft() {
  return { weekStartDay: WEEK_DAYS[1], dayBoundary: '' };
}

function wfmFormFields(d) {
  return `
    <div class="grid-2">
      <div class="field"><label>Week start day</label>
        <select data-wf="wfm-field" data-id="weekStartDay">${WEEK_DAYS.map((w) => `<option value="${w}" ${d.weekStartDay === w ? 'selected' : ''}>${w[0].toUpperCase()}${w.slice(1)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Day boundary</label><input data-wf="wfm-field" data-id="dayBoundary" type="time" value="${esc(d.dayBoundary)}" /></div>
    </div>`;
}

function wfmPanel(state, id, wfmStatus) {
  if (!wfmStatus || wfmStatus.loading) return `<div class="skel" style="height:40px"></div>`;
  if (wfmStatus.error) return `<p class="muted">${esc(wfmStatus.error)}</p>`;
  const saved = wfmStatus.settings;
  const saving = state.wf.saving?.updateWfmDefaults;
  const d = state.wfmDraft || emptyWfmDraft();
  return `
    ${wfmFormFields(d)}
    <div class="actions" style="margin-top:10px">
      <button class="btn btn-primary" data-act="update-wfm-defaults-go" data-id="${id}" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save WFM defaults'}</button>
    </div>
    ${saved?.weekStartDay ? `<p class="hint" style="margin-top:8px">Currently saved: ${esc(saved.weekStartDay)}${saved.dayBoundary ? `, day boundary ${esc(saved.dayBoundary)}` : ''}.</p>` : ''}`;
}

function lockedPanelBody() {
  return `<p class="muted">Available once the tenant is created — fill in Company Information and hit Create first. This same drawer then unlocks it, no need to reopen anything.</p>`;
}

function tenantDetailDrawer(state) {
  const id = state.tenantDetailId;
  if (!id) {
    // Pre-creation: the full 7-panel checklist, filled in up front —
    // single-submit onboarding. Company Information/Primary Admin/
    // Organization/WFM Configuration are all real, editable field panels
    // right now (admin and org unit are optional — leave them blank to
    // skip that step). Data Sources/Security/Analytics have no create
    // action at all regardless of submit style (Data Sources needs real
    // tenant-owned credentials, Security/Analytics are self-serve or
    // observability-only), so they stay locked/informational.
    const adminDraft = state.provisionAdminDraft || emptyProvisionDraft();
    const orgDraft = state.orgUnitDraft || emptyOrgUnitDraft();
    const wfmDraft = state.wfmDraft || emptyWfmDraft();
    const body = [
      accordionPanel(state, 'company', 'Company Information', false, 'Not yet created', createFormPanelBody(state)),
      accordionPanel(state, 'admin', 'Primary Admin', false, 'Optional — fill in to invite now', adminFormFields(adminDraft), false),
      accordionPanel(state, 'org', 'Organization', false, 'Optional — fill in to create now', orgFormFields(orgDraft), false),
      accordionPanel(state, 'wfm', 'WFM Configuration', false, 'Defaults ready to save', wfmFormFields(wfmDraft), false),
      accordionPanel(state, 'datasources', 'Data Sources', false, 'Create the tenant first', lockedPanelBody(), false),
      accordionPanel(state, 'security', 'Security', false, 'Create the tenant first', lockedPanelBody(), false),
      accordionPanel(state, 'analytics', 'Analytics', false, 'Create the tenant first', lockedPanelBody(), false),
    ].join('');
    const saving = state.wf.saving?.createTenant;
    const footer = `<button class="btn btn-primary" data-act="create-tenant-go" ${saving ? 'disabled' : ''}>${saving ? 'Creating…' : 'Create & Provision Tenant'}</button>`;
    return drawerShell('Create tenant', 'POST /v1/tenants', body, `<button class="btn" data-act="close-drawer">Cancel</button>`, footer);
  }
  const cache = (state.wf.tenantDetail || {})[id];
  if (!cache || cache.loading) {
    return drawerShell('Tenant', '', `<div class="skel" style="height:80px"></div>`, `<button class="btn" data-act="close-drawer">Close</button>`, '');
  }
  if (cache.error) {
    return drawerShell('Tenant', '', `<p class="muted">${esc(cache.error)}</p>`, `<button class="btn" data-act="close-drawer">Close</button>`, '');
  }
  const t = cache.tenant;

  const provisionResult = state.wf.provisionResult?.[id];
  const adminDone = t.status !== 'provisioning' || !!provisionResult;
  const adminStatusText = adminDone ? 'Provisioned' : 'Not yet provisioned';

  const orgStatus = state.wf.orgUnitStatus?.[id];
  const orgDone = orgStatus?.hasOrgUnits === true;
  const orgStatusText = !orgStatus || orgStatus.loading ? 'Checking…' : orgStatus.error ? 'Could not check' : orgDone ? 'Created' : 'Not yet created';

  const healthLoading = state.wf.tenantHealth === undefined || state.wf.tenantHealth.loading;
  const healthRow = healthRowFor(state, id);
  const securityDone = healthRow?.ssoConfigured === true;
  const securityStatusText = healthLoading ? 'Checking…' : securityDone ? 'SSO configured' : 'Not yet configured';

  const wfmStatus = state.wf.wfmDefaults?.[id];
  const wfmDone = !!wfmStatus?.settings?.weekStartDay;
  const wfmStatusText = !wfmStatus || wfmStatus.loading ? 'Checking…' : wfmStatus.error ? 'Could not check' : wfmDone ? `${wfmStatus.settings.weekStartDay} start` : 'Not yet configured';

  const connectorStatus = state.wf.connectorStatus?.[id];
  const connectorsDone = connectorStatus?.hasConnectors === true;
  const connectorsStatusText = !connectorStatus || connectorStatus.loading ? 'Checking…' : connectorStatus.error ? 'Could not check' : connectorsDone ? 'Configured' : 'None (platform_admin can\'t create one — see panel)';

  const body = [
    accordionPanel(state, 'company', 'Company Information', true, `${t.tier} · ${t.dataResidencyRegion}`, companyPanel(t)),
    accordionPanel(state, 'admin', 'Primary Admin', adminDone, adminStatusText, adminPanel(state, id)),
    accordionPanel(state, 'org', 'Organization', orgDone, orgStatusText, orgPanel(state, id, orgStatus)),
    accordionPanel(state, 'wfm', 'WFM Configuration', wfmDone, wfmStatusText, wfmPanel(state, id, wfmStatus)),
    accordionPanel(state, 'datasources', 'Data Sources', connectorsDone, connectorsStatusText, dataSourcesPanel(connectorStatus)),
    accordionPanel(state, 'security', 'Security', securityDone, securityStatusText, securityPanel(state, id, healthLoading, healthRow)),
    accordionPanel(state, 'analytics', 'Analytics', true, 'Onboarding funnel & health', analyticsSection(state, id)),
  ].join('');

  return drawerShell(esc(t.name), `GET /v1/tenants/${t.id}`, body, `<button class="btn" data-act="close-drawer">Close</button>`, '');
}

export function renderDrawer(state) {
  if (state.drawer === 'tenant-detail') return tenantDetailDrawer(state);
  return '';
}

export function handle(state, act, id, value) {
  if (act === 'open-create-tenant') {
    state.createTenantDraft = emptyCreateDraft();
    state.provisionAdminDraft = emptyProvisionDraft();
    state.orgUnitDraft = emptyOrgUnitDraft();
    state.wfmDraft = emptyWfmDraft();
    state.tenantDetailId = null;
    state.drawer = 'tenant-detail';
    // Every pre-creation panel is keyed "null:<section>" (tenantDetailId is
    // null until a tenant exists) - every "+ Create Tenant" click shares
    // those same seven keys, so a manual toggle from a PRIOR create attempt
    // would otherwise stick forever (most visibly: a collapsed Company
    // Information hiding the form behind a closed accordion on every
    // future attempt). Clear all of them here so a fresh create flow
    // always starts from the same default state.
    if (state.wf.accordionManual) {
      Object.keys(state.wf.accordionManual)
        .filter((k) => k.startsWith('null:'))
        .forEach((k) => delete state.wf.accordionManual[k]);
    }
    return true;
  }
  if (act === 'open-tenant-detail') {
    state.tenantDetailId = id;
    state.provisionAdminDraft = emptyProvisionDraft();
    state.orgUnitDraft = emptyOrgUnitDraft();
    state.wfmDraft = emptyWfmDraft();
    state.drawer = 'tenant-detail';
    if (!(state.wf.tenantDetail || {})[id]) loadTenantDetail(state, id);
    if (!(state.wf.orgUnitStatus || {})[id]) loadOrgUnitStatus(state, id);
    if (!(state.wf.wfmDefaults || {})[id]) loadWfmDefaults(state, id);
    if (!(state.wf.connectorStatus || {})[id]) loadConnectorStatus(state, id);
    ensureAnalyticsLoaded(state);
    return true;
  }
  if (act === 'close-drawer') {
    state.drawer = null;
    return true;
  }
  if (act === 'toggle-accordion') {
    const key = `${state.tenantDetailId}:${id}`;
    state.wf.accordionManual = state.wf.accordionManual || {};
    state.wf.accordionManual[key] = !(state.wf.accordionEffective?.[key] ?? false);
    return true;
  }

  if (act === 'ct-field') {
    state.createTenantDraft = state.createTenantDraft || emptyCreateDraft();
    state.createTenantDraft[id] = value;
    return true;
  }
  if (act === 'pa-field') {
    state.provisionAdminDraft = state.provisionAdminDraft || emptyProvisionDraft();
    state.provisionAdminDraft[id] = value;
    return true;
  }
  if (act === 'ou-field') {
    state.orgUnitDraft = state.orgUnitDraft || emptyOrgUnitDraft();
    state.orgUnitDraft[id] = value;
    return true;
  }
  if (act === 'wfm-field') {
    state.wfmDraft = state.wfmDraft || emptyWfmDraft();
    state.wfmDraft[id] = value;
    return true;
  }

  if (act === 'create-tenant-go') {
    const d = state.createTenantDraft || emptyCreateDraft();
    const name = (d.name || '').trim();
    const dataResidencyRegion = (d.dataResidencyRegion || '').trim();
    const slug = (d.slug || '').trim().toLowerCase();
    if (!name) { toast('Tenant name is required.'); return true; }
    if (!dataResidencyRegion) { toast('Data residency region is required.'); return true; }
    if (!slug) { toast('Slug is required.'); return true; }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) { toast('Slug must be lowercase alphanumeric segments separated by hyphens.'); return true; }
    state.wf.saving = state.wf.saving || {};
    state.wf.saving.createTenant = true;
    doRerender();
    TenantMonitoringApi.createTenant({
      name,
      tier: d.tier || TIERS[0],
      dataResidencyRegion,
      slug,
      industry: (d.industry || '').trim() || undefined,
      country: (d.country || '').trim().toUpperCase() || undefined,
      currency: (d.currency || '').trim().toUpperCase() || undefined,
      language: (d.language || '').trim() || undefined,
    })
      .then((created) => {
        state.wf.saving.createTenant = false;
        toast('Tenant created.');
        // Continue in the same drawer, straight into the full accordion —
        // the create response already has the full tenant record, so no
        // extra round-trip is needed to seed tenantDetail.
        state.tenantDetailId = created.id;
        state.wf.tenantDetail = state.wf.tenantDetail || {};
        state.wf.tenantDetail[created.id] = { tenant: created };
        if (!(state.wf.orgUnitStatus || {})[created.id]) loadOrgUnitStatus(state, created.id);
        if (!(state.wf.wfmDefaults || {})[created.id]) loadWfmDefaults(state, created.id);
        if (!(state.wf.connectorStatus || {})[created.id]) loadConnectorStatus(state, created.id);
        ensureAnalyticsLoaded(state);
        state.wf.allTenants = undefined;
        loadAllTenants(state);
        // Single-submit: whatever Primary Admin/Organization fields the
        // user also filled in on the pre-creation checklist fire right now,
        // through the exact same handlers their post-creation panel buttons
        // use — same validation, same state mutations, same retry story if
        // one of them fails. A blank field means "skip this step", exactly
        // like leaving it for later in the post-creation accordion. WFM
        // Configuration always has a valid default, so it always saves.
        const adminDraft = state.provisionAdminDraft;
        if ((adminDraft?.email || '').trim()) handle(state, 'provision-admin-go', created.id);
        const orgDraft = state.orgUnitDraft;
        if ((orgDraft?.name || '').trim()) handle(state, 'create-org-unit-go', created.id);
        handle(state, 'update-wfm-defaults-go', created.id);
        state.createTenantDraft = null;
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.createTenant = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'provision-admin-go') {
    const d = state.provisionAdminDraft || emptyProvisionDraft();
    const email = (d.email || '').trim();
    const givenName = (d.givenName || '').trim() || undefined;
    const familyName = (d.familyName || '').trim() || undefined;
    const phone = (d.phone || '').trim() || undefined;
    const jobTitle = (d.jobTitle || '').trim() || undefined;
    if (!email) { toast('Email is required.'); return true; }
    state.wf.saving = state.wf.saving || {};
    state.wf.saving.provisionAdmin = true;
    doRerender();
    TenantMonitoringApi.provisionTenantAdmin(id, { email, givenName, familyName, phone, jobTitle })
      .then((result) => {
        state.wf.saving.provisionAdmin = false;
        state.wf.provisionResult = state.wf.provisionResult || {};
        state.wf.provisionResult[id] = result;
        state.provisionAdminDraft = null;
        toast('Admin provisioned.');
        doRerender();
        loadTenantDetail(state, id);
        state.wf.allTenants = undefined;
        loadAllTenants(state);
      })
      .catch((err) => {
        state.wf.saving.provisionAdmin = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'create-org-unit-go') {
    const d = state.orgUnitDraft || emptyOrgUnitDraft();
    const name = (d.name || '').trim();
    const timezone = (d.timezone || '').trim();
    const countryCode = (d.countryCode || '').trim().toUpperCase();
    if (!name) { toast('Organization name is required.'); return true; }
    if (!timezone) { toast('Timezone is required.'); return true; }
    if (countryCode.length !== 2) { toast('Country code must be exactly 2 letters.'); return true; }
    state.wf.saving = state.wf.saving || {};
    state.wf.saving.createOrgUnit = true;
    doRerender();
    TenantMonitoringApi.provisionOrgUnit(id, { type: d.type || ORG_UNIT_TYPES[0], name, timezone, countryCode })
      .then(() => {
        state.wf.saving.createOrgUnit = false;
        state.orgUnitDraft = null;
        toast('Organization created.');
        doRerender();
        loadOrgUnitStatus(state, id);
      })
      .catch((err) => {
        state.wf.saving.createOrgUnit = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'update-wfm-defaults-go') {
    const d = state.wfmDraft || emptyWfmDraft();
    const dayBoundary = (d.dayBoundary || '').trim() || undefined;
    state.wf.saving = state.wf.saving || {};
    state.wf.saving.updateWfmDefaults = true;
    doRerender();
    TenantMonitoringApi.updateWfmDefaults(id, { weekStartDay: d.weekStartDay || WEEK_DAYS[1], dayBoundary })
      .then(() => {
        state.wf.saving.updateWfmDefaults = false;
        toast('WFM defaults saved.');
        doRerender();
        loadWfmDefaults(state, id);
      })
      .catch((err) => {
        state.wf.saving.updateWfmDefaults = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  return false;
}
