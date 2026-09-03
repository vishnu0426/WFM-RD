/* Platform > Feature Flags — cross-tenant view/toggle over org.feature_flags
   (root service, GET/PUT /v1/feature-flags/:flagKey[/tenants/:tenantId]).
   `flag_key` has no enum/catalog anywhere in the backend (free-text column,
   "meant to be reusable by any future feature" per the entity's own doc
   comment) — only `bulk_import_destructive` is in active use today, but
   this screen can look up and manage any key, not just that one. */
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, empty } from '../../identity-org/shared/ui.js';
import * as TenantMonitoringApi from '../api.js';

const DEFAULT_FLAG_KEY = 'bulk_import_destructive';

async function loadFlag(state, flagKey) {
  state.wf.featureFlagList = { loading: true };
  doRerender();
  try {
    state.wf.featureFlagList = await TenantMonitoringApi.listFeatureFlagForAllTenants(flagKey);
  } catch (err) {
    state.wf.featureFlagList = { error: errMsg(err) };
  }
  doRerender();
}

export function render(state) {
  if (state.featureFlagKey === undefined) state.featureFlagKey = DEFAULT_FLAG_KEY;
  const cache = state.wf.featureFlagList;
  if (cache === undefined) loadFlag(state, state.featureFlagKey);

  const head = pageHead(
    'Feature Flags',
    'Per-tenant feature gating — cross-tenant view. flag_key is free text; only bulk_import_destructive is in active use today.',
    '',
  );

  const search = `
    <div class="field" style="max-width:360px;margin-bottom:14px">
      <label>Flag key</label>
      <div style="display:flex;gap:8px">
        <input id="ff-key-input" value="${esc(state.featureFlagKey)}" style="flex:1" />
        <button class="btn" data-act="ff-load">Load</button>
      </div>
    </div>`;

  if (!cache || cache.loading) {
    return `${head}${search}<div class="panel"><div class="skel" style="height:120px"></div></div>`;
  }
  if (cache.error) {
    return `${head}${search}<div class="panel">${empty('Could not load this flag.', cache.error)}</div>`;
  }
  if (!cache.tenants.length) {
    return `${head}${search}<div class="panel">${empty('No tenants yet.')}</div>`;
  }

  const rows = cache.tenants
    .map(
      (t) => `
      <tr>
        <td><b>${esc(t.tenantName)}</b></td>
        <td>${t.enabled ? '<span class="badge badge-ok"><span class="pip"></span>Enabled</span>' : '<span class="badge badge-sys"><span class="pip"></span>Disabled</span>'}</td>
        <td><button class="btn btn-sm" data-act="ff-toggle" data-id="${t.tenantId}" ${state.wf.saving?.[`ff:${t.tenantId}`] ? 'disabled' : ''}>${t.enabled ? 'Disable' : 'Enable'}</button></td>
      </tr>`,
    )
    .join('');

  return `
    ${head}
    ${search}
    <div class="panel">
      <div style="overflow-x:auto">
        <table class="data">
          <thead><tr><th>Tenant</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

export function handle(state, act, id) {
  if (act === 'ff-load') {
    const input = document.getElementById('ff-key-input');
    const key = (input?.value || '').trim();
    if (!key) { toast('Flag key is required.'); return true; }
    state.featureFlagKey = key;
    state.wf.featureFlagList = undefined;
    doRerender();
    return true;
  }
  if (act === 'ff-toggle') {
    const cache = state.wf.featureFlagList;
    const row = cache?.tenants?.find((t) => t.tenantId === id);
    if (!row) return true;
    const nextEnabled = !row.enabled;
    state.wf.saving = state.wf.saving || {};
    state.wf.saving[`ff:${id}`] = true;
    doRerender();
    TenantMonitoringApi.setFeatureFlagForTenant(state.featureFlagKey, id, nextEnabled)
      .then(() => {
        state.wf.saving[`ff:${id}`] = false;
        row.enabled = nextEnabled;
        toast(nextEnabled ? 'Flag enabled.' : 'Flag disabled.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving[`ff:${id}`] = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
