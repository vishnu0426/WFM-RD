/* System Configuration → Advanced. System Limits and Maintenance Mode —
   both real, backed by the generic /v1/policies API (SystemLimitsPolicyService/
   MaintenanceModeMiddleware). System Limits are enforced at the real
   creation choke points (user invite, employee create, org unit create) —
   not every user-creation path (SSO JIT/SCIM/platform-admin provisioning
   aren't covered this round, disclosed in the UI copy below rather than
   claimed watertight). Maintenance Mode genuinely rejects non-GET requests
   for this tenant once enabled — a platform_admin bypass always exists. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec } from '../shared/ui.js';

const SYSTEM_LIMITS_POLICY_TYPE = 'system_limits';
const MAINTENANCE_MODE_POLICY_TYPE = 'maintenance_mode';

function loadSystemLimits(state) {
  state.wf.systemLimitsPolicy = { loading: true };
  Api.rootApi(`/v1/policies?policyType=${SYSTEM_LIMITS_POLICY_TYPE}`)
    .then((rows) => {
      const active = rows.find((r) => !r.effectiveTo) || rows[0] || null;
      state.wf.systemLimitsPolicy = {
        policyGroupId: active ? active.policyGroupId : null,
        maxUsers: active && active.definition.maxUsers != null ? String(active.definition.maxUsers) : '',
        maxEmployees: active && active.definition.maxEmployees != null ? String(active.definition.maxEmployees) : '',
        maxOrgUnits: active && active.definition.maxOrgUnits != null ? String(active.definition.maxOrgUnits) : '',
      };
      doRerender();
    })
    .catch((err) => {
      state.wf.systemLimitsPolicy = { error: errMsg(err) };
      doRerender();
    });
}

function loadMaintenance(state) {
  state.wf.maintenancePolicy = { loading: true };
  Api.rootApi(`/v1/policies?policyType=${MAINTENANCE_MODE_POLICY_TYPE}`)
    .then((rows) => {
      const active = rows.find((r) => !r.effectiveTo) || rows[0] || null;
      state.wf.maintenancePolicy = {
        policyGroupId: active ? active.policyGroupId : null,
        enabled: active ? !!active.definition.enabled : false,
        message: active ? active.definition.message || '' : '',
      };
      doRerender();
    })
    .catch((err) => {
      state.wf.maintenancePolicy = { error: errMsg(err) };
      doRerender();
    });
}

function systemLimitsCard(state) {
  const sl = state.wf.systemLimitsPolicy;
  if (!sl || sl.loading) return sec('System Limits', `<div class="skel" style="height:40px"></div>`, '');
  if (sl.error) return sec('System Limits', `<p class="muted">${esc(sl.error)}</p>`, '');
  const d = state.scLimitsDraft || { maxUsers: sl.maxUsers, maxEmployees: sl.maxEmployees, maxOrgUnits: sl.maxOrgUnits };
  const dirty = JSON.stringify(d) !== JSON.stringify({ maxUsers: sl.maxUsers, maxEmployees: sl.maxEmployees, maxOrgUnits: sl.maxOrgUnits });
  const saving = state.wf.saving.scLimits;
  return sec('System Limits', `
    <p class="hint" style="margin:0 0 10px">Distinct from a plan/entitlement limit — this platform has no plan system. Leave blank for no limit. Enforced on invite/create for users, employees, and organization units respectively; not every user-creation path (SSO/SCIM/platform-admin provisioning) is covered yet.</p>
    <div class="grid-2">
      <div class="field"><label>Max users</label><input data-wf="sc-limits-field" data-id="maxUsers" type="number" min="0" value="${esc(d.maxUsers)}" /></div>
      <div class="field"><label>Max employees</label><input data-wf="sc-limits-field" data-id="maxEmployees" type="number" min="0" value="${esc(d.maxEmployees)}" /></div>
    </div>
    <div class="field" style="margin-top:10px;max-width:calc(50% - 6px)"><label>Max organization units</label><input data-wf="sc-limits-field" data-id="maxOrgUnits" type="number" min="0" value="${esc(d.maxOrgUnits)}" /></div>
    <div class="actions" style="margin-top:10px">
      <button class="btn" data-wf="sc-limits-revert" ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-primary" data-wf="sc-limits-save" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>
    </div>
  `, `<span class="meta">POST /v1/policies (policyType=system_limits)</span>`);
}

function maintenanceCard(state) {
  const mm = state.wf.maintenancePolicy;
  if (!mm || mm.loading) return sec('Maintenance Mode', `<div class="skel" style="height:40px"></div>`, '');
  if (mm.error) return sec('Maintenance Mode', `<p class="muted">${esc(mm.error)}</p>`, '');
  const d = state.scMaintenanceDraft || { enabled: mm.enabled, message: mm.message };
  const dirty = d.enabled !== mm.enabled || d.message !== mm.message;
  const saving = state.wf.saving.scMaintenance;
  return sec('Maintenance Mode', `
    <p class="hint" style="margin:0 0 10px">While enabled, non-GET requests for this tenant are rejected with 503 (platform_admin always bypasses). Toggling this is audited like any other configuration change.</p>
    <div class="field"><label><input type="checkbox" data-wf="sc-maintenance-toggle" ${d.enabled ? 'checked' : ''} /> This tenant is in maintenance mode</label></div>
    <div class="field" style="margin-top:10px"><label>Message shown to blocked requests</label><input data-wf="sc-maintenance-field" data-id="message" placeholder="We'll be back shortly." value="${esc(d.message)}" /></div>
    <div class="actions" style="margin-top:10px">
      <button class="btn" data-wf="sc-maintenance-revert" ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-primary" data-wf="sc-maintenance-save" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>
    </div>
  `, `<span class="meta">POST /v1/policies (policyType=maintenance_mode)</span>`);
}

export function render(state) {
  if (state.wf.systemLimitsPolicy === null) loadSystemLimits(state);
  if (state.wf.maintenancePolicy === null) loadMaintenance(state);
  return `
    ${pageHead('Advanced', 'System limits and maintenance mode for this tenant.', '')}
    ${systemLimitsCard(state)}
    ${maintenanceCard(state)}`;
}

export function handle(state, act, id, value) {
  if (act === 'sc-limits-field') {
    const sl = state.wf.systemLimitsPolicy;
    state.scLimitsDraft = state.scLimitsDraft || { maxUsers: sl.maxUsers, maxEmployees: sl.maxEmployees, maxOrgUnits: sl.maxOrgUnits };
    state.scLimitsDraft[id] = value;
    return true;
  }
  if (act === 'sc-limits-revert') {
    state.scLimitsDraft = null;
    return true;
  }
  if (act === 'sc-limits-save') {
    const sl = state.wf.systemLimitsPolicy;
    const d = state.scLimitsDraft;
    const toNum = (s) => (s === '' ? undefined : Number(s));
    state.wf.saving.scLimits = true;
    doRerender();
    Api.rootApi('/v1/policies', {
      method: 'POST',
      body: {
        policyGroupId: sl.policyGroupId || undefined,
        policyType: SYSTEM_LIMITS_POLICY_TYPE,
        definition: { maxUsers: toNum(d.maxUsers), maxEmployees: toNum(d.maxEmployees), maxOrgUnits: toNum(d.maxOrgUnits) },
      },
    })
      .then((created) => {
        state.wf.saving.scLimits = false;
        state.wf.systemLimitsPolicy = { policyGroupId: created.policyGroupId, ...d };
        state.scLimitsDraft = null;
        toast('System limits saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.scLimits = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'sc-maintenance-toggle') {
    const mm = state.wf.maintenancePolicy;
    const el = document.querySelector('[data-wf="sc-maintenance-toggle"]');
    state.scMaintenanceDraft = state.scMaintenanceDraft || { enabled: mm.enabled, message: mm.message };
    state.scMaintenanceDraft.enabled = !!(el && el.checked);
    return true;
  }
  if (act === 'sc-maintenance-field') {
    const mm = state.wf.maintenancePolicy;
    state.scMaintenanceDraft = state.scMaintenanceDraft || { enabled: mm.enabled, message: mm.message };
    state.scMaintenanceDraft[id] = value;
    return true;
  }
  if (act === 'sc-maintenance-revert') {
    state.scMaintenanceDraft = null;
    return true;
  }
  if (act === 'sc-maintenance-save') {
    const mm = state.wf.maintenancePolicy;
    const d = state.scMaintenanceDraft;
    state.wf.saving.scMaintenance = true;
    doRerender();
    Api.rootApi('/v1/policies', {
      method: 'POST',
      body: {
        policyGroupId: mm.policyGroupId || undefined,
        policyType: MAINTENANCE_MODE_POLICY_TYPE,
        definition: { enabled: d.enabled, message: d.message || undefined },
      },
    })
      .then((created) => {
        state.wf.saving.scMaintenance = false;
        state.wf.maintenancePolicy = { policyGroupId: created.policyGroupId, enabled: d.enabled, message: d.message };
        state.scMaintenanceDraft = null;
        toast(d.enabled ? 'Maintenance mode enabled.' : 'Maintenance mode disabled.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.scMaintenance = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
