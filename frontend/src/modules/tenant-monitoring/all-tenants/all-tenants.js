/* Tenants > All Tenants — the platform_admin console's actual onboarding
   screen: list every tenant (root service, GET /v1/tenants/all — the one
   genuinely cross-tenant list endpoint that exists, see tenant-management.
   controller.ts), create a new one, and walk it through onboarding.

   The tenant detail drawer is an accordion checklist — Company Information
   / Primary Admin / Organization / WFM Configuration / General / Security /
   Email / Notifications / Advanced / Data Sources / Analytics — where each
   panel's ✓/○ status is derived from real data on every render (tenant
   status, a live org-units-exist check, the health rollup's ssoConfigured
   field), never a stored "onboarding progress" flag.

   General/Security/Email/Notifications/Advanced are cross-tenant writes
   through TenantConfigAdminController (src/modules/tenant/rest/
   tenant-config-admin.controller.ts, GET/PUT/POST /v1/tenants/:id/config/*)
   — a platform_admin acting on a tenant that may not have a logged-in admin
   yet to configure it themselves. Same underlying TenantSettings/Policy/
   NotificationRule rows the tenant's own /v1/tenant-settings and /v1/policies
   self-service routes read and write; this is a second entry point onto the
   same data, not a shadow copy. SSO/Identity-Providers full CRUD and
   Retention are deliberately not here — see this round's plan for why.

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
import { pageHead, sec, empty, fmtDt, drawerShell } from '../../identity-org/shared/ui.js';
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

/* The real IANA time zone database, straight from the browser's own ICU
   data — same source frontend/src/modules/identity-org/system-config/
   general.js's own Timezone field uses; duplicated rather than imported
   since that's an ambient-tenant module with a different calling
   convention (see the Platform Admin doc comment above). */
const TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [
      'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
      'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo',
      'Asia/Shanghai', 'Asia/Singapore', 'Australia/Sydney',
    ];
  }
})();

const AUTH_METHODS = [
  { id: 'pwd', label: 'Password' },
  { id: 'webauthn', label: 'WebAuthn (security key / platform authenticator)' },
];
const NOTIF_CHANNELS = ['email', 'sms', 'push', 'in_app'];

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

/* Platform Admin cross-tenant System Configuration — General/Security/
   Email share ONE underlying TenantSettingsView (same GET body from any of
   the three routes), so one cache serves all three panels. Policy-backed
   panels (auth method / access restriction / system limits / maintenance)
   each hit GET /v1/tenants/:id/config/:policyType, which returns the single
   active Policy row or null directly — NOT the array the tenant's own
   GET /v1/policies?policyType=X returns, so no rows.find() here. */
async function loadTenantConfigSettings(state, id) {
  state.wf.tenantConfigSettings = state.wf.tenantConfigSettings || {};
  state.wf.tenantConfigSettings[id] = { loading: true };
  doRerender();
  try {
    state.wf.tenantConfigSettings[id] = { settings: await TenantMonitoringApi.getTenantConfigGeneral(id) };
  } catch (err) {
    state.wf.tenantConfigSettings[id] = { error: errMsg(err) };
  }
  doRerender();
}

async function loadTenantConfigAuthPolicy(state, id) {
  state.wf.tenantConfigAuthPolicy = state.wf.tenantConfigAuthPolicy || {};
  state.wf.tenantConfigAuthPolicy[id] = { loading: true };
  doRerender();
  try {
    const active = await TenantMonitoringApi.getTenantConfigPolicy(id, 'auth_method_policy');
    state.wf.tenantConfigAuthPolicy[id] = {
      policyGroupId: active ? active.policyGroupId : null,
      requiredMethods: active ? active.definition.requiredMethods || [] : [],
      allowedMethods: active ? active.definition.allowedMethods || ['pwd', 'webauthn'] : ['pwd', 'webauthn'],
    };
  } catch (err) {
    state.wf.tenantConfigAuthPolicy[id] = { error: errMsg(err) };
  }
  doRerender();
}

async function loadTenantConfigAccessPolicy(state, id) {
  state.wf.tenantConfigAccessPolicy = state.wf.tenantConfigAccessPolicy || {};
  state.wf.tenantConfigAccessPolicy[id] = { loading: true };
  doRerender();
  try {
    const active = await TenantMonitoringApi.getTenantConfigPolicy(id, 'access_restriction_policy');
    state.wf.tenantConfigAccessPolicy[id] = {
      policyGroupId: active ? active.policyGroupId : null,
      ipAllowlist: active ? (active.definition.ipAllowlist || []).join('\n') : '',
      allowedEmailDomains: active ? (active.definition.allowedEmailDomains || []).join('\n') : '',
    };
  } catch (err) {
    state.wf.tenantConfigAccessPolicy[id] = { error: errMsg(err) };
  }
  doRerender();
}

async function loadTenantConfigNotifRules(state, id) {
  state.wf.tenantConfigNotifRules = state.wf.tenantConfigNotifRules || {};
  state.wf.tenantConfigNotifRules[id] = { loading: true };
  doRerender();
  try {
    state.wf.tenantConfigNotifRules[id] = { rows: await TenantMonitoringApi.listTenantConfigNotificationRules(id) };
  } catch (err) {
    state.wf.tenantConfigNotifRules[id] = { error: errMsg(err) };
  }
  doRerender();
}

async function loadTenantConfigLimitsPolicy(state, id) {
  state.wf.tenantConfigLimitsPolicy = state.wf.tenantConfigLimitsPolicy || {};
  state.wf.tenantConfigLimitsPolicy[id] = { loading: true };
  doRerender();
  try {
    const active = await TenantMonitoringApi.getTenantConfigPolicy(id, 'system_limits');
    state.wf.tenantConfigLimitsPolicy[id] = {
      policyGroupId: active ? active.policyGroupId : null,
      maxUsers: active && active.definition.maxUsers != null ? String(active.definition.maxUsers) : '',
      maxEmployees: active && active.definition.maxEmployees != null ? String(active.definition.maxEmployees) : '',
      maxOrgUnits: active && active.definition.maxOrgUnits != null ? String(active.definition.maxOrgUnits) : '',
    };
  } catch (err) {
    state.wf.tenantConfigLimitsPolicy[id] = { error: errMsg(err) };
  }
  doRerender();
}

async function loadTenantConfigMaintenancePolicy(state, id) {
  state.wf.tenantConfigMaintenancePolicy = state.wf.tenantConfigMaintenancePolicy || {};
  state.wf.tenantConfigMaintenancePolicy[id] = { loading: true };
  doRerender();
  try {
    const active = await TenantMonitoringApi.getTenantConfigPolicy(id, 'maintenance_mode');
    state.wf.tenantConfigMaintenancePolicy[id] = {
      policyGroupId: active ? active.policyGroupId : null,
      enabled: active ? !!active.definition.enabled : false,
      message: active ? active.definition.message || '' : '',
    };
  } catch (err) {
    state.wf.tenantConfigMaintenancePolicy[id] = { error: errMsg(err) };
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

function emptyTcGeneralDraft(s) {
  return { timezone: s.timezone || '', locale: s.locale || '', brandLogoUrl: s.brandLogoUrl || '' };
}

function generalConfigPanel(state, id, cfgStatus) {
  if (!cfgStatus || cfgStatus.loading) return `<div class="skel" style="height:60px"></div>`;
  if (cfgStatus.error) return `<p class="muted">${esc(cfgStatus.error)}</p>`;
  const s = cfgStatus.settings;
  if (!state.tcGeneralDraft) state.tcGeneralDraft = emptyTcGeneralDraft(s);
  const d = state.tcGeneralDraft;
  const dirty = JSON.stringify(d) !== JSON.stringify(emptyTcGeneralDraft(s));
  const saving = state.wf.saving?.tcGeneral;
  return `
    <div class="field"><label>Timezone</label>
      <select data-wf="tc-general-field" data-id="timezone">
        <option value="">—</option>
        ${TIMEZONES.map((tz) => `<option value="${tz}" ${d.timezone === tz ? 'selected' : ''}>${tz}</option>`).join('')}
      </select>
    </div>
    <div class="field" style="margin-top:10px"><label>Locale</label><input data-wf="tc-general-field" data-id="locale" placeholder="e.g. en-US" value="${esc(d.locale)}" /></div>
    <div class="field" style="margin-top:10px"><label>Brand logo URL</label><input data-wf="tc-general-field" data-id="brandLogoUrl" placeholder="https://…" value="${esc(d.brandLogoUrl)}" /></div>
    <div class="actions" style="margin-top:10px">
      <button class="btn" data-act="tc-general-revert" data-id="${id}" ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-primary" data-act="tc-general-save" data-id="${id}" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>
    </div>`;
}

function emptyTcSecurityDraft(s) {
  return {
    passwordMinLength: s.passwordMinLength,
    passwordRequireUppercase: s.passwordRequireUppercase,
    passwordRequireNumber: s.passwordRequireNumber,
    passwordRequireSymbol: s.passwordRequireSymbol,
    passwordExpiryDays: s.passwordExpiryDays == null ? '' : String(s.passwordExpiryDays),
  };
}

function tcPasswordPolicyCard(state, id, s) {
  if (!state.tcSecurityDraft) state.tcSecurityDraft = emptyTcSecurityDraft(s);
  const d = state.tcSecurityDraft;
  const dirty = JSON.stringify(d) !== JSON.stringify(emptyTcSecurityDraft(s));
  const saving = state.wf.saving?.tcSecurity;
  return sec('Password Policy', `
    <div class="grid-2">
      <div class="field"><label>Minimum length</label><input data-wf="tc-sec-field" data-id="passwordMinLength" type="number" min="8" max="128" value="${d.passwordMinLength}" /></div>
      <div class="field"><label>Expires after (days, blank = never)</label><input data-wf="tc-sec-field" data-id="passwordExpiryDays" type="number" min="1" value="${esc(d.passwordExpiryDays)}" /></div>
    </div>
    <div class="field" style="margin-top:10px">
      <label><input type="checkbox" data-wf="tc-sec-toggle" data-id="passwordRequireUppercase" ${d.passwordRequireUppercase ? 'checked' : ''} /> Require an uppercase letter</label><br/>
      <label><input type="checkbox" data-wf="tc-sec-toggle" data-id="passwordRequireNumber" ${d.passwordRequireNumber ? 'checked' : ''} /> Require a number</label><br/>
      <label><input type="checkbox" data-wf="tc-sec-toggle" data-id="passwordRequireSymbol" ${d.passwordRequireSymbol ? 'checked' : ''} /> Require a symbol</label>
    </div>
    <div class="actions" style="margin-top:10px">
      <button class="btn" data-act="tc-sec-revert" data-id="${id}" ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-primary" data-act="tc-sec-save" data-id="${id}" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>
    </div>
  `);
}

/* Each checkbox carries its scope ("allowed"/"required") as its own
   `value` attribute, read back via the change event's value param — NOT
   via a data-scope dataset attribute matched against that same value.
   (The tenant-facing sc-authpolicy-toggle in identity-org/system-config/
   security.js does the latter, but neither app/shell.js's nor
   app/platform-admin-shell.js's change listener ever reads dataset.scope —
   only t.value — so an un-valued checkbox's value defaults to "on" and
   that match can never succeed. Flagged separately; not fixed here since
   it's a different module, out of this round's scope.) */
function tcAuthMethodCard(state, id, ap) {
  if (!ap || ap.loading) return sec('Required Authentication Method', `<div class="skel" style="height:40px"></div>`, '');
  if (ap.error) return sec('Required Authentication Method', `<p class="muted">${esc(ap.error)}</p>`, '');
  const d = state.tcAuthPolicyDraft || { requiredMethods: [...ap.requiredMethods], allowedMethods: [...ap.allowedMethods] };
  const dirty = JSON.stringify({ requiredMethods: d.requiredMethods, allowedMethods: d.allowedMethods }) !==
    JSON.stringify({ requiredMethods: ap.requiredMethods, allowedMethods: ap.allowedMethods });
  const saving = state.wf.saving?.tcAuthPolicy;
  return sec('Required Authentication Method', `
    <p class="hint" style="margin:0 0 10px">If "Required" is empty, any allowed method is accepted at login. If set, a login must use one of the required methods, even if others are also allowed.</p>
    <table class="data"><thead><tr><th>Method</th><th>Allowed</th><th>Required</th></tr></thead>
    <tbody>${AUTH_METHODS.map((m) => `<tr>
      <td>${esc(m.label)}</td>
      <td><input type="checkbox" data-wf="tc-authpolicy-toggle" data-id="${m.id}" value="allowed" ${d.allowedMethods.includes(m.id) ? 'checked' : ''} /></td>
      <td><input type="checkbox" data-wf="tc-authpolicy-toggle" data-id="${m.id}" value="required" ${d.requiredMethods.includes(m.id) ? 'checked' : ''} ${d.allowedMethods.includes(m.id) ? '' : 'disabled'} /></td>
    </tr>`).join('')}</tbody></table>
    <div class="actions" style="margin-top:10px">
      <button class="btn" data-act="tc-authpolicy-revert" data-id="${id}" ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-primary" data-act="tc-authpolicy-save" data-id="${id}" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>
    </div>
  `);
}

function tcAccessRestrictionCard(state, id, ap) {
  if (!ap || ap.loading) return sec('Access Restrictions', `<div class="skel" style="height:40px"></div>`, '');
  if (ap.error) return sec('Access Restrictions', `<p class="muted">${esc(ap.error)}</p>`, '');
  const d = state.tcAccessDraft || { ipAllowlist: ap.ipAllowlist, allowedEmailDomains: ap.allowedEmailDomains };
  const dirty = d.ipAllowlist !== ap.ipAllowlist || d.allowedEmailDomains !== ap.allowedEmailDomains;
  const saving = state.wf.saving?.tcAccess;
  return sec('Access Restrictions', `
    <p class="hint" style="margin:0 0 10px">One entry per line. Leave both blank to allow any IP/domain (no restriction). IP entries are either an exact address or a whole-octet prefix ending in "." (e.g. "10.0.") — not full CIDR notation.</p>
    <div class="grid-2">
      <div class="field"><label>IP allowlist</label><textarea data-wf="tc-access-field" data-id="ipAllowlist" rows="4" placeholder="203.0.113.4&#10;10.0.">${esc(d.ipAllowlist)}</textarea></div>
      <div class="field"><label>Allowed email domains</label><textarea data-wf="tc-access-field" data-id="allowedEmailDomains" rows="4" placeholder="acme-demo.example">${esc(d.allowedEmailDomains)}</textarea></div>
    </div>
    <div class="actions" style="margin-top:10px">
      <button class="btn" data-act="tc-access-revert" data-id="${id}" ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-primary" data-act="tc-access-save" data-id="${id}" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>
    </div>
  `);
}

function securityConfigPanel(state, id, cfgStatus, authPolicyStatus, accessPolicyStatus, healthRow) {
  if (!cfgStatus || cfgStatus.loading) return `<div class="skel" style="height:60px"></div>`;
  if (cfgStatus.error) return `<p class="muted">${esc(cfgStatus.error)}</p>`;
  const ssoHint = healthRow?.ssoConfigured
    ? `<p class="hint" style="margin:0 0 10px">SSO/SCIM is also configured for this tenant (set by its own admin — not editable here).</p>`
    : '';
  return ssoHint + tcPasswordPolicyCard(state, id, cfgStatus.settings) + tcAuthMethodCard(state, id, authPolicyStatus) + tcAccessRestrictionCard(state, id, accessPolicyStatus);
}

function emptyTcEmailDraft(s) {
  return {
    smtpHost: s.smtpHost || '',
    smtpPort: s.smtpPort == null ? '' : String(s.smtpPort),
    smtpUsername: s.smtpUsername || '',
    smtpPassword: '',
    smtpFromAddress: s.smtpFromAddress || '',
    smtpUseTls: s.smtpUseTls,
  };
}

function emailConfigPanel(state, id, cfgStatus) {
  if (!cfgStatus || cfgStatus.loading) return `<div class="skel" style="height:60px"></div>`;
  if (cfgStatus.error) return `<p class="muted">${esc(cfgStatus.error)}</p>`;
  const s = cfgStatus.settings;
  if (!state.tcEmailDraft) state.tcEmailDraft = emptyTcEmailDraft(s);
  const d = state.tcEmailDraft;
  const dirty = JSON.stringify(d) !== JSON.stringify(emptyTcEmailDraft(s));
  const saving = state.wf.saving?.tcEmail;
  const testing = state.wf.saving?.tcEmailTest;
  const testResult = state.tcEmailTestResult;
  return `
    ${testResult ? `<p style="margin:0 0 10px">${esc(testResult.message)}</p>` : ''}
    <div class="grid-2">
      <div class="field"><label>Host</label><input data-wf="tc-email-field" data-id="smtpHost" placeholder="smtp.example.com" value="${esc(d.smtpHost)}" /></div>
      <div class="field"><label>Port</label><input data-wf="tc-email-field" data-id="smtpPort" type="number" min="1" max="65535" value="${esc(d.smtpPort)}" /></div>
    </div>
    <div class="grid-2" style="margin-top:10px">
      <div class="field"><label>Username</label><input data-wf="tc-email-field" data-id="smtpUsername" value="${esc(d.smtpUsername)}" /></div>
      <div class="field"><label>Password ${s.smtpPasswordSet ? '<span class="meta">(set — leave blank to keep)</span>' : ''}</label><input data-wf="tc-email-field" data-id="smtpPassword" type="password" placeholder="${s.smtpPasswordSet ? '••••••••' : ''}" value="${esc(d.smtpPassword)}" /></div>
    </div>
    <div class="field" style="margin-top:10px"><label>From address</label><input data-wf="tc-email-field" data-id="smtpFromAddress" placeholder="noreply@example.com" value="${esc(d.smtpFromAddress)}" /></div>
    <div class="field" style="margin-top:10px"><label><input type="checkbox" data-wf="tc-email-tls" data-id="_" ${d.smtpUseTls ? 'checked' : ''} /> Use TLS</label></div>
    <div class="actions" style="margin-top:10px">
      <button class="btn" data-act="tc-email-test" data-id="${id}" ${testing ? 'disabled' : ''}>${testing ? 'Testing…' : 'Test Connection'}</button>
      <button class="btn" data-act="tc-email-revert" data-id="${id}" ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-primary" data-act="tc-email-save" data-id="${id}" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>
    </div>`;
}

function notificationsConfigPanel(state, id, rulesStatus) {
  if (!rulesStatus || rulesStatus.loading) return `<div class="skel" style="height:60px"></div>`;
  if (rulesStatus.error) return `<p class="muted">${esc(rulesStatus.error)}</p>`;
  const rows = rulesStatus.rows || [];
  const key = (state.tcNotifEventType || 'skill_expiring').trim();
  const forKey = (channel) => rows.find((r) => r.eventType === key && r.channel === channel);
  const saving = state.wf.saving?.tcNotif || {};
  return `
    <div class="field"><label>Event type</label><input data-wf="tc-notif-key" data-id="_" value="${esc(state.tcNotifEventType || 'skill_expiring')}" placeholder="event type" style="max-width:320px" /></div>
    <p class="hint" style="margin:6px 0 10px">Only <code>skill_expiring</code> has a real producer in this platform today — the key is free text, same as the tenant's own screen. A user's own preference always overrides this default.</p>
    <table class="data"><thead><tr><th>Channel</th><th>Default</th><th></th></tr></thead><tbody>
      ${NOTIF_CHANNELS.map((c) => {
        const rule = forKey(c);
        const enabled = rule ? rule.enabled : false;
        return `<tr>
          <td class="mono">${c}</td>
          <td>${rule ? (enabled ? 'Enabled' : 'Disabled') : '<span class="muted">Not set (off)</span>'}</td>
          <td><button class="btn btn-sm" data-act="tc-notif-toggle" data-id="${c}" ${saving[c] ? 'disabled' : ''}>${saving[c] ? 'Saving…' : enabled ? 'Disable' : 'Enable'}</button></td>
        </tr>`;
      }).join('')}
    </tbody></table>
    ${rows.length === 0 ? `<p class="hint" style="margin-top:8px">No tenant-wide rules configured yet — a user without their own preference gets nothing until a default is set here.</p>` : ''}`;
}

function tcSystemLimitsCard(state, id, sl) {
  if (!sl || sl.loading) return sec('System Limits', `<div class="skel" style="height:40px"></div>`, '');
  if (sl.error) return sec('System Limits', `<p class="muted">${esc(sl.error)}</p>`, '');
  const d = state.tcLimitsDraft || { maxUsers: sl.maxUsers, maxEmployees: sl.maxEmployees, maxOrgUnits: sl.maxOrgUnits };
  const dirty = JSON.stringify(d) !== JSON.stringify({ maxUsers: sl.maxUsers, maxEmployees: sl.maxEmployees, maxOrgUnits: sl.maxOrgUnits });
  const saving = state.wf.saving?.tcLimits;
  return sec('System Limits', `
    <p class="hint" style="margin:0 0 10px">Leave blank for no limit. Enforced on invite/create for users, employees, and organization units respectively; not every user-creation path (SSO/SCIM/platform-admin provisioning) is covered yet.</p>
    <div class="grid-2">
      <div class="field"><label>Max users</label><input data-wf="tc-limits-field" data-id="maxUsers" type="number" min="0" value="${esc(d.maxUsers)}" /></div>
      <div class="field"><label>Max employees</label><input data-wf="tc-limits-field" data-id="maxEmployees" type="number" min="0" value="${esc(d.maxEmployees)}" /></div>
    </div>
    <div class="field" style="margin-top:10px;max-width:calc(50% - 6px)"><label>Max organization units</label><input data-wf="tc-limits-field" data-id="maxOrgUnits" type="number" min="0" value="${esc(d.maxOrgUnits)}" /></div>
    <div class="actions" style="margin-top:10px">
      <button class="btn" data-act="tc-limits-revert" data-id="${id}" ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-primary" data-act="tc-limits-save" data-id="${id}" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>
    </div>
  `);
}

function tcMaintenanceCard(state, id, mm) {
  if (!mm || mm.loading) return sec('Maintenance Mode', `<div class="skel" style="height:40px"></div>`, '');
  if (mm.error) return sec('Maintenance Mode', `<p class="muted">${esc(mm.error)}</p>`, '');
  const d = state.tcMaintenanceDraft || { enabled: mm.enabled, message: mm.message };
  const dirty = d.enabled !== mm.enabled || d.message !== mm.message;
  const saving = state.wf.saving?.tcMaintenance;
  return sec('Maintenance Mode', `
    <p class="hint" style="margin:0 0 10px">While enabled, non-GET requests for this tenant are rejected with 503 (platform_admin always bypasses). Toggling this is audited like any other configuration change.</p>
    <div class="field"><label><input type="checkbox" data-wf="tc-maintenance-toggle" data-id="_" ${d.enabled ? 'checked' : ''} /> This tenant is in maintenance mode</label></div>
    <div class="field" style="margin-top:10px"><label>Message shown to blocked requests</label><input data-wf="tc-maintenance-field" data-id="message" placeholder="We'll be back shortly." value="${esc(d.message)}" /></div>
    <div class="actions" style="margin-top:10px">
      <button class="btn" data-act="tc-maintenance-revert" data-id="${id}" ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-primary" data-act="tc-maintenance-save" data-id="${id}" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>
    </div>
  `);
}

function advancedConfigPanel(state, id, limitsStatus, maintenanceStatus) {
  return tcSystemLimitsCard(state, id, limitsStatus) + tcMaintenanceCard(state, id, maintenanceStatus);
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
    return drawerShell('Create tenant', 'Provision a new tenant and its initial admin user.', body, `<button class="btn" data-act="close-drawer">Cancel</button>`, footer);
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

  const cfgStatus = state.wf.tenantConfigSettings?.[id];
  const generalStatusText = !cfgStatus || cfgStatus.loading ? 'Checking…' : cfgStatus.error ? 'Could not check' : (cfgStatus.settings?.timezone || 'No timezone set');

  const authPolicyStatus = state.wf.tenantConfigAuthPolicy?.[id];
  const accessPolicyStatus = state.wf.tenantConfigAccessPolicy?.[id];

  const emailStatusText = !cfgStatus || cfgStatus.loading ? 'Checking…' : cfgStatus.error ? 'Could not check' : cfgStatus.settings?.smtpHost ? `SMTP configured (${cfgStatus.settings.smtpHost})` : 'Not yet configured';

  const notifRulesStatus = state.wf.tenantConfigNotifRules?.[id];
  const notifStatusText = !notifRulesStatus || notifRulesStatus.loading ? 'Checking…' : notifRulesStatus.error ? 'Could not check' : `${(notifRulesStatus.rows || []).length} tenant-wide rule(s)`;

  const limitsStatus = state.wf.tenantConfigLimitsPolicy?.[id];
  const maintenanceStatus = state.wf.tenantConfigMaintenancePolicy?.[id];
  const advancedStatusText = !maintenanceStatus || maintenanceStatus.loading ? 'Checking…' : maintenanceStatus.error ? 'Could not check' : maintenanceStatus.enabled ? 'Maintenance mode ON' : 'Limits & maintenance mode';

  const body = [
    accordionPanel(state, 'company', 'Company Information', true, `${t.tier} · ${t.dataResidencyRegion}`, companyPanel(t)),
    accordionPanel(state, 'admin', 'Primary Admin', adminDone, adminStatusText, adminPanel(state, id)),
    accordionPanel(state, 'org', 'Organization', orgDone, orgStatusText, orgPanel(state, id, orgStatus)),
    accordionPanel(state, 'wfm', 'WFM Configuration', wfmDone, wfmStatusText, wfmPanel(state, id, wfmStatus)),
    accordionPanel(state, 'general', 'General', true, generalStatusText, generalConfigPanel(state, id, cfgStatus), false),
    accordionPanel(state, 'security', 'Security', securityDone, securityStatusText, securityConfigPanel(state, id, cfgStatus, authPolicyStatus, accessPolicyStatus, healthRow), false),
    accordionPanel(state, 'email', 'Email', true, emailStatusText, emailConfigPanel(state, id, cfgStatus), false),
    accordionPanel(state, 'notifications', 'Notifications', true, notifStatusText, notificationsConfigPanel(state, id, notifRulesStatus), false),
    accordionPanel(state, 'advanced', 'Advanced', true, advancedStatusText, advancedConfigPanel(state, id, limitsStatus, maintenanceStatus), false),
    accordionPanel(state, 'datasources', 'Data Sources', connectorsDone, connectorsStatusText, dataSourcesPanel(connectorStatus)),
    accordionPanel(state, 'analytics', 'Analytics', true, 'Onboarding funnel & health', analyticsSection(state, id)),
  ].join('');

  return drawerShell(esc(t.name), 'Tenant details.', body, `<button class="btn" data-act="close-drawer">Close</button>`, '');
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
    state.tcGeneralDraft = null;
    state.tcSecurityDraft = null;
    state.tcAuthPolicyDraft = null;
    state.tcAccessDraft = null;
    state.tcEmailDraft = null;
    state.tcEmailTestResult = null;
    state.tcNotifEventType = null;
    state.tcLimitsDraft = null;
    state.tcMaintenanceDraft = null;
    state.drawer = 'tenant-detail';
    if (!(state.wf.tenantDetail || {})[id]) loadTenantDetail(state, id);
    if (!(state.wf.orgUnitStatus || {})[id]) loadOrgUnitStatus(state, id);
    if (!(state.wf.wfmDefaults || {})[id]) loadWfmDefaults(state, id);
    if (!(state.wf.connectorStatus || {})[id]) loadConnectorStatus(state, id);
    if (!(state.wf.tenantConfigSettings || {})[id]) loadTenantConfigSettings(state, id);
    if (!(state.wf.tenantConfigAuthPolicy || {})[id]) loadTenantConfigAuthPolicy(state, id);
    if (!(state.wf.tenantConfigAccessPolicy || {})[id]) loadTenantConfigAccessPolicy(state, id);
    if (!(state.wf.tenantConfigNotifRules || {})[id]) loadTenantConfigNotifRules(state, id);
    if (!(state.wf.tenantConfigLimitsPolicy || {})[id]) loadTenantConfigLimitsPolicy(state, id);
    if (!(state.wf.tenantConfigMaintenancePolicy || {})[id]) loadTenantConfigMaintenancePolicy(state, id);
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

  if (act === 'tc-general-field') {
    state.tcGeneralDraft = state.tcGeneralDraft || emptyTcGeneralDraft(state.wf.tenantConfigSettings[state.tenantDetailId].settings);
    state.tcGeneralDraft[id] = value;
    return true;
  }
  if (act === 'tc-general-revert') {
    state.tcGeneralDraft = null;
    return true;
  }
  if (act === 'tc-general-save') {
    const d = state.tcGeneralDraft;
    state.wf.saving = state.wf.saving || {};
    state.wf.saving.tcGeneral = true;
    doRerender();
    TenantMonitoringApi.updateTenantConfigGeneral(id, {
      timezone: (d.timezone || '').trim() || undefined,
      locale: (d.locale || '').trim() || undefined,
      brandLogoUrl: (d.brandLogoUrl || '').trim() || null,
    })
      .then((updated) => {
        state.wf.saving.tcGeneral = false;
        state.wf.tenantConfigSettings[id] = { settings: updated };
        state.tcGeneralDraft = null;
        toast('General settings saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.tcGeneral = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'tc-sec-field') {
    state.tcSecurityDraft = state.tcSecurityDraft || emptyTcSecurityDraft(state.wf.tenantConfigSettings[state.tenantDetailId].settings);
    state.tcSecurityDraft[id] = id === 'passwordMinLength' ? Number(value) : value;
    return true;
  }
  if (act === 'tc-sec-toggle') {
    const el = document.querySelector(`[data-wf="tc-sec-toggle"][data-id="${id}"]`);
    state.tcSecurityDraft = state.tcSecurityDraft || emptyTcSecurityDraft(state.wf.tenantConfigSettings[state.tenantDetailId].settings);
    state.tcSecurityDraft[id] = !!(el && el.checked);
    return true;
  }
  if (act === 'tc-sec-revert') {
    state.tcSecurityDraft = null;
    return true;
  }
  if (act === 'tc-sec-save') {
    const d = state.tcSecurityDraft;
    const passwordExpiryDays = d.passwordExpiryDays === '' ? null : Number(d.passwordExpiryDays);
    state.wf.saving = state.wf.saving || {};
    state.wf.saving.tcSecurity = true;
    doRerender();
    TenantMonitoringApi.updateTenantConfigSecurity(id, {
      passwordMinLength: d.passwordMinLength,
      passwordRequireUppercase: d.passwordRequireUppercase,
      passwordRequireNumber: d.passwordRequireNumber,
      passwordRequireSymbol: d.passwordRequireSymbol,
      passwordExpiryDays,
    })
      .then((updated) => {
        state.wf.saving.tcSecurity = false;
        state.wf.tenantConfigSettings[id] = { settings: updated };
        state.tcSecurityDraft = null;
        toast('Password policy saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.tcSecurity = false;
        // PLATFORM_SECURITY_BASELINE_VIOLATION carries details.violations —
        // one specific reason per failed baseline rule (Platform Settings →
        // Security Baseline) — surface those instead of the generic message.
        toast(err.details?.violations?.length ? err.details.violations.join(' ') : errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'tc-authpolicy-toggle') {
    const ap = state.wf.tenantConfigAuthPolicy[state.tenantDetailId];
    const scope = value; // 'allowed' | 'required' — the checkbox's own value attribute, see tcAuthMethodCard's doc comment
    const el = document.querySelector(`[data-wf="tc-authpolicy-toggle"][data-id="${id}"][value="${scope}"]`);
    state.tcAuthPolicyDraft = state.tcAuthPolicyDraft || { requiredMethods: [...ap.requiredMethods], allowedMethods: [...ap.allowedMethods] };
    const d = state.tcAuthPolicyDraft;
    const checked = !!(el && el.checked);
    const key = scope === 'allowed' ? 'allowedMethods' : 'requiredMethods';
    d[key] = checked ? [...new Set([...d[key], id])] : d[key].filter((m) => m !== id);
    if (key === 'allowedMethods' && !checked) {
      d.requiredMethods = d.requiredMethods.filter((m) => m !== id);
    }
    return true;
  }
  if (act === 'tc-authpolicy-revert') {
    state.tcAuthPolicyDraft = null;
    return true;
  }
  if (act === 'tc-authpolicy-save') {
    const ap = state.wf.tenantConfigAuthPolicy[id];
    const d = state.tcAuthPolicyDraft;
    if (d.requiredMethods.some((m) => !d.allowedMethods.includes(m))) {
      toast('A required method must also be allowed.');
      return true;
    }
    state.wf.saving = state.wf.saving || {};
    state.wf.saving.tcAuthPolicy = true;
    doRerender();
    TenantMonitoringApi.setTenantConfigPolicy(id, 'auth_method_policy', ap.policyGroupId, { requiredMethods: d.requiredMethods, allowedMethods: d.allowedMethods })
      .then((created) => {
        state.wf.saving.tcAuthPolicy = false;
        state.wf.tenantConfigAuthPolicy[id] = { policyGroupId: created.policyGroupId, requiredMethods: d.requiredMethods, allowedMethods: d.allowedMethods };
        state.tcAuthPolicyDraft = null;
        toast('Required authentication method saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.tcAuthPolicy = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'tc-access-field') {
    const ap = state.wf.tenantConfigAccessPolicy[state.tenantDetailId];
    state.tcAccessDraft = state.tcAccessDraft || { ipAllowlist: ap.ipAllowlist, allowedEmailDomains: ap.allowedEmailDomains };
    state.tcAccessDraft[id] = value;
    return true;
  }
  if (act === 'tc-access-revert') {
    state.tcAccessDraft = null;
    return true;
  }
  if (act === 'tc-access-save') {
    const ap = state.wf.tenantConfigAccessPolicy[id];
    const d = state.tcAccessDraft;
    const ipAllowlist = d.ipAllowlist.split('\n').map((s) => s.trim()).filter(Boolean);
    const allowedEmailDomains = d.allowedEmailDomains.split('\n').map((s) => s.trim()).filter(Boolean);
    state.wf.saving = state.wf.saving || {};
    state.wf.saving.tcAccess = true;
    doRerender();
    TenantMonitoringApi.setTenantConfigPolicy(id, 'access_restriction_policy', ap.policyGroupId, { ipAllowlist, allowedEmailDomains })
      .then((created) => {
        state.wf.saving.tcAccess = false;
        state.wf.tenantConfigAccessPolicy[id] = { policyGroupId: created.policyGroupId, ipAllowlist: ipAllowlist.join('\n'), allowedEmailDomains: allowedEmailDomains.join('\n') };
        state.tcAccessDraft = null;
        toast('Access restrictions saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.tcAccess = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'tc-email-field') {
    state.tcEmailDraft = state.tcEmailDraft || emptyTcEmailDraft(state.wf.tenantConfigSettings[state.tenantDetailId].settings);
    state.tcEmailDraft[id] = value;
    return true;
  }
  if (act === 'tc-email-tls') {
    const el = document.querySelector('[data-wf="tc-email-tls"]');
    state.tcEmailDraft = state.tcEmailDraft || emptyTcEmailDraft(state.wf.tenantConfigSettings[state.tenantDetailId].settings);
    state.tcEmailDraft.smtpUseTls = !!(el && el.checked);
    return true;
  }
  if (act === 'tc-email-revert') {
    state.tcEmailDraft = null;
    return true;
  }
  if (act === 'tc-email-test') {
    state.wf.saving = state.wf.saving || {};
    state.wf.saving.tcEmailTest = true;
    state.tcEmailTestResult = null;
    doRerender();
    TenantMonitoringApi.testTenantConfigEmail(id)
      .then((result) => {
        state.wf.saving.tcEmailTest = false;
        state.tcEmailTestResult = result;
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.tcEmailTest = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === 'tc-email-save') {
    const d = state.tcEmailDraft;
    state.wf.saving = state.wf.saving || {};
    state.wf.saving.tcEmail = true;
    doRerender();
    TenantMonitoringApi.updateTenantConfigEmail(id, {
      smtpHost: (d.smtpHost || '').trim() || null,
      smtpPort: d.smtpPort === '' ? null : Number(d.smtpPort),
      smtpUsername: (d.smtpUsername || '').trim() || null,
      smtpPassword: (d.smtpPassword || '').trim() || undefined,
      smtpFromAddress: (d.smtpFromAddress || '').trim() || null,
      smtpUseTls: d.smtpUseTls,
    })
      .then((updated) => {
        state.wf.saving.tcEmail = false;
        state.wf.tenantConfigSettings[id] = { settings: updated };
        state.tcEmailDraft = null;
        toast('Email settings saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.tcEmail = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'tc-notif-key') {
    state.tcNotifEventType = value;
    return true;
  }
  if (act === 'tc-notif-toggle') {
    const tenantId = state.tenantDetailId;
    const key = (state.tcNotifEventType || 'skill_expiring').trim();
    const rows = (state.wf.tenantConfigNotifRules?.[tenantId]?.rows) || [];
    const rule = rows.find((r) => r.eventType === key && r.channel === id);
    const nextEnabled = !(rule ? rule.enabled : false);
    state.wf.saving = state.wf.saving || {};
    state.wf.saving.tcNotif = state.wf.saving.tcNotif || {};
    state.wf.saving.tcNotif[id] = true;
    doRerender();
    TenantMonitoringApi.setTenantConfigNotificationRule(tenantId, key, id, nextEnabled)
      .then(() => {
        state.wf.saving.tcNotif[id] = false;
        toast('Notification rule saved.');
        doRerender();
        loadTenantConfigNotifRules(state, tenantId);
      })
      .catch((err) => {
        state.wf.saving.tcNotif[id] = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'tc-limits-field') {
    const sl = state.wf.tenantConfigLimitsPolicy[state.tenantDetailId];
    state.tcLimitsDraft = state.tcLimitsDraft || { maxUsers: sl.maxUsers, maxEmployees: sl.maxEmployees, maxOrgUnits: sl.maxOrgUnits };
    state.tcLimitsDraft[id] = value;
    return true;
  }
  if (act === 'tc-limits-revert') {
    state.tcLimitsDraft = null;
    return true;
  }
  if (act === 'tc-limits-save') {
    const sl = state.wf.tenantConfigLimitsPolicy[id];
    const d = state.tcLimitsDraft;
    const toNum = (s) => (s === '' ? undefined : Number(s));
    state.wf.saving = state.wf.saving || {};
    state.wf.saving.tcLimits = true;
    doRerender();
    TenantMonitoringApi.setTenantConfigPolicy(id, 'system_limits', sl.policyGroupId, { maxUsers: toNum(d.maxUsers), maxEmployees: toNum(d.maxEmployees), maxOrgUnits: toNum(d.maxOrgUnits) })
      .then((created) => {
        state.wf.saving.tcLimits = false;
        state.wf.tenantConfigLimitsPolicy[id] = { policyGroupId: created.policyGroupId, ...d };
        state.tcLimitsDraft = null;
        toast('System limits saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.tcLimits = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'tc-maintenance-toggle') {
    const mm = state.wf.tenantConfigMaintenancePolicy[state.tenantDetailId];
    const el = document.querySelector('[data-wf="tc-maintenance-toggle"]');
    state.tcMaintenanceDraft = state.tcMaintenanceDraft || { enabled: mm.enabled, message: mm.message };
    state.tcMaintenanceDraft.enabled = !!(el && el.checked);
    return true;
  }
  if (act === 'tc-maintenance-field') {
    const mm = state.wf.tenantConfigMaintenancePolicy[state.tenantDetailId];
    state.tcMaintenanceDraft = state.tcMaintenanceDraft || { enabled: mm.enabled, message: mm.message };
    state.tcMaintenanceDraft[id] = value;
    return true;
  }
  if (act === 'tc-maintenance-revert') {
    state.tcMaintenanceDraft = null;
    return true;
  }
  if (act === 'tc-maintenance-save') {
    const mm = state.wf.tenantConfigMaintenancePolicy[id];
    const d = state.tcMaintenanceDraft;
    state.wf.saving = state.wf.saving || {};
    state.wf.saving.tcMaintenance = true;
    doRerender();
    TenantMonitoringApi.setTenantConfigPolicy(id, 'maintenance_mode', mm.policyGroupId, { enabled: d.enabled, message: d.message || undefined })
      .then((created) => {
        state.wf.saving.tcMaintenance = false;
        state.wf.tenantConfigMaintenancePolicy[id] = { policyGroupId: created.policyGroupId, enabled: d.enabled, message: d.message };
        state.tcMaintenanceDraft = null;
        toast(d.enabled ? 'Maintenance mode enabled.' : 'Maintenance mode disabled.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.tcMaintenance = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  return false;
}

/* Reused by ../system-config/system-config.js — the standalone, top-level
   Platform > System Configuration screen is a second entry point onto these
   same cross-tenant panels/loaders (pick-a-tenant instead of open-a-drawer),
   not a fork of them. Both screens key off the same state.tenantDetailId
   plus the state.wf.tenantConfig-prefixed caches and state.tc-prefixed
   drafts, so editing General/Security/Email/Notifications/Advanced from
   either place stays in sync with the other automatically. */
export {
  loadAllTenants,
  healthRowFor,
  loadTenantConfigSettings,
  loadTenantConfigAuthPolicy,
  loadTenantConfigAccessPolicy,
  loadTenantConfigNotifRules,
  loadTenantConfigLimitsPolicy,
  loadTenantConfigMaintenancePolicy,
  generalConfigPanel,
  securityConfigPanel,
  emailConfigPanel,
  notificationsConfigPanel,
  advancedConfigPanel,
};
