/* Platform Admin > Platform > System Configuration — a standalone, top-level
   entry point onto the same cross-tenant config panels the All Tenants
   drawer's own General/Security/Email/Notifications/Advanced accordion
   sections expose (all-tenants.js) — reused directly here, not duplicated.
   Exists because platform_admin has no "ambient tenant" the way a logged-in
   tenant_admin does on their own System Configuration screen (identity-org/
   system-config/*), so the first step here is always "pick a tenant" — the
   same reason this whole cross-tenant feature exists in the first place: a
   newly-created tenant has no admin yet to configure it themselves.

   Shares state.tenantDetailId as the "tenant currently in focus" pointer
   with the All Tenants drawer (all-tenants.js) — picking a tenant here, or
   opening that tenant's drawer there, both point the same underlying
   state.wf.tenantConfig-prefixed caches and state.tc-prefixed drafts at it,
   so edits made from either screen stay in sync with the other. The tc-* field/save/revert
   actions these panels render (data-wf="tc-*", data-act="tc-*") are handled
   by AllTenants.handle() itself, not duplicated here — index.js's own
   handle() already runs AllTenants.handle() before any tab's own module,
   regardless of which tab is active (same reasoning its own doc comment
   gives for the drawer's open-create-tenant/close-drawer actions). */
import { esc } from '../../../core/dom.js';
import { pageHead, sec } from '../../identity-org/shared/ui.js';
import * as AllTenants from '../all-tenants/all-tenants.js';

function tenantPicker(state, tenants) {
  const id = state.tenantDetailId || '';
  return `
    <div class="field" style="max-width:420px">
      <label>Tenant</label>
      <select data-wf="tm-sc-pick-tenant">
        <option value="">— choose a tenant —</option>
        ${tenants.map((t) => `<option value="${t.id}" ${id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
      </select>
    </div>`;
}

export function render(state) {
  const cache = state.wf.allTenants;
  if (cache === undefined) AllTenants.loadAllTenants(state);

  const head = pageHead('System Configuration', "Configure any tenant's System Configuration on their behalf — useful right after creating a tenant, before its own admin has logged in and set it up themselves.", '');

  if (!cache || cache.loading) {
    return `${head}<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  }
  if (cache.error) {
    return `${head}<p class="muted">${esc(cache.error)}</p>`;
  }

  const tenants = cache.tenants || [];
  const id = state.tenantDetailId;
  const picker = sec('Tenant', tenantPicker(state, tenants), '');

  if (!id) {
    return `${head}${picker}`;
  }

  const cfgStatus = state.wf.tenantConfigSettings?.[id];
  const authPolicyStatus = state.wf.tenantConfigAuthPolicy?.[id];
  const accessPolicyStatus = state.wf.tenantConfigAccessPolicy?.[id];
  const notifRulesStatus = state.wf.tenantConfigNotifRules?.[id];
  const limitsStatus = state.wf.tenantConfigLimitsPolicy?.[id];
  const maintenanceStatus = state.wf.tenantConfigMaintenancePolicy?.[id];
  const healthRow = AllTenants.healthRowFor(state, id);

  return `
    ${head}
    ${picker}
    ${sec('General', AllTenants.generalConfigPanel(state, id, cfgStatus), '')}
    ${sec('Security', AllTenants.securityConfigPanel(state, id, cfgStatus, authPolicyStatus, accessPolicyStatus, healthRow), '')}
    ${sec('Email', AllTenants.emailConfigPanel(state, id, cfgStatus), '')}
    ${sec('Notifications', AllTenants.notificationsConfigPanel(state, id, notifRulesStatus), '')}
    ${sec('Advanced', AllTenants.advancedConfigPanel(state, id, limitsStatus, maintenanceStatus), '')}`;
}

export function handle(state, act, id, value) {
  if (act === 'tm-sc-pick-tenant') {
    const tenantId = value || null;
    state.tenantDetailId = tenantId;
    state.tcGeneralDraft = null;
    state.tcSecurityDraft = null;
    state.tcAuthPolicyDraft = null;
    state.tcAccessDraft = null;
    state.tcEmailDraft = null;
    state.tcEmailTestResult = null;
    state.tcNotifEventType = null;
    state.tcLimitsDraft = null;
    state.tcMaintenanceDraft = null;
    if (tenantId) {
      if (!(state.wf.tenantConfigSettings || {})[tenantId]) AllTenants.loadTenantConfigSettings(state, tenantId);
      if (!(state.wf.tenantConfigAuthPolicy || {})[tenantId]) AllTenants.loadTenantConfigAuthPolicy(state, tenantId);
      if (!(state.wf.tenantConfigAccessPolicy || {})[tenantId]) AllTenants.loadTenantConfigAccessPolicy(state, tenantId);
      if (!(state.wf.tenantConfigNotifRules || {})[tenantId]) AllTenants.loadTenantConfigNotifRules(state, tenantId);
      if (!(state.wf.tenantConfigLimitsPolicy || {})[tenantId]) AllTenants.loadTenantConfigLimitsPolicy(state, tenantId);
      if (!(state.wf.tenantConfigMaintenancePolicy || {})[tenantId]) AllTenants.loadTenantConfigMaintenancePolicy(state, tenantId);
    }
    return true;
  }
  return false;
}
