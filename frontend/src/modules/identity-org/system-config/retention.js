/* System Configuration → Retention. TenantSettings.dataRetentionDays is a
   confirmed dead column with no consumer anywhere — the only real,
   cron-enforced retention mechanism in this platform is
   adherence-compliance-service's own RetentionPolicy (per-jurisdiction,
   in years, governing compliance report lifecycle). This screen integrates
   with that real, cross-service API rather than exposing the dead field. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, fmtDt, drawerShell } from '../shared/ui.js';

const REPORT_TYPES = ['adherence_summary', 'overtime_audit', 'rest_period_audit', 'regulator_export'];

function loadRetentionPolicies(state) {
  state.wf.retentionPolicies = { loading: true };
  Api.adherenceComplianceApi('/v1/compliance/retention-policies')
    .then((rows) => {
      state.wf.retentionPolicies = { rows };
      doRerender();
    })
    .catch((err) => {
      state.wf.retentionPolicies = { error: errMsg(err) };
      doRerender();
    });
}

function emptyDraft(editing) {
  return {
    jurisdiction: editing ? editing.jurisdiction : '',
    retentionYears: editing ? String(editing.retentionYears) : '7',
    appliesToReportTypes: editing ? [...(editing.appliesToReportTypes || [])] : [],
  };
}

export function render(state) {
  if (!state.wf.retentionPolicies) loadRetentionPolicies(state);
  const list = state.wf.retentionPolicies;
  const body = !list || list.loading
    ? `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`
    : list.error
      ? `<p class="muted">${esc(list.error)}</p>`
      : list.rows.length === 0
        ? empty('No retention policies configured.', 'The platform default applies until a tenant-specific override is set.')
        : `<table class="data"><thead><tr><th>Jurisdiction</th><th>Retention</th><th>Report types</th><th>Source</th><th></th></tr></thead><tbody>
            ${list.rows.map((p) => `<tr>
              <td class="mono">${esc(p.jurisdiction)}</td>
              <td>${p.retentionYears} year${p.retentionYears === 1 ? '' : 's'}</td>
              <td>${p.appliesToReportTypes && p.appliesToReportTypes.length ? esc(p.appliesToReportTypes.join(', ')) : 'all report types'}</td>
              <td>${p.isPlatformDefault ? '<span class="muted">Platform default</span>' : `Tenant override <span class="meta">${fmtDt(p.createdAt)}</span>`}</td>
              <td><button class="btn btn-sm" data-wf="sc-retention-edit" data-id="${esc(p.jurisdiction)}">Override</button></td>
            </tr>`).join('')}
          </tbody></table>`;
  return `
    ${pageHead('Retention', 'Compliance report retention, per jurisdiction (adherence-compliance-service).', `<button class="btn btn-primary" data-wf="sc-retention-open">+ New override</button>`)}
    ${sec('Retention policies', body)}`;
}

export function renderDrawer(state) {
  if (state.drawer !== 'sc-retention') return '';
  const editing = state.scRetentionEditTarget;
  const d = state.scRetentionDraft;
  const saving = state.wf.saving.scRetention;
  return drawerShell(
    editing ? `Override retention — ${esc(editing.jurisdiction)}` : 'New retention override',
    editing ? 'Update this jurisdiction\u2019s retention override.' : 'Add a retention override for a specific jurisdiction.',
    `
    <div class="field"><label>Jurisdiction</label><input data-wf="sc-retention-field" data-id="jurisdiction" placeholder="e.g. US, EU, UK" value="${esc(d.jurisdiction)}" ${editing ? 'disabled' : ''} /></div>
    <div class="field" style="margin-top:10px"><label>Retention (years)</label><input data-wf="sc-retention-field" data-id="retentionYears" type="number" min="1" value="${esc(d.retentionYears)}" /></div>
    <div class="field" style="margin-top:10px"><label>Applies to report types (none = all)</label>
      ${REPORT_TYPES.map((t) => `<label style="display:block"><input type="checkbox" data-wf="sc-retention-type-toggle" data-id="${t}" ${d.appliesToReportTypes.includes(t) ? 'checked' : ''} /> ${esc(t)}</label>`).join('')}
    </div>`,
    `<button class="btn" data-wf="close-drawer">Cancel</button>`,
    `<button class="btn btn-primary" data-wf="sc-retention-go" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save'}</button>`,
  );
}

export function handle(state, act, id, value) {
  if (act === 'sc-retention-open') {
    state.scRetentionEditTarget = null;
    state.scRetentionDraft = emptyDraft(null);
    state.drawer = 'sc-retention';
    return true;
  }
  if (act === 'sc-retention-edit') {
    const target = (state.wf.retentionPolicies.rows || []).find((p) => p.jurisdiction === id);
    state.scRetentionEditTarget = target;
    state.scRetentionDraft = emptyDraft(target);
    state.drawer = 'sc-retention';
    return true;
  }
  if (act === 'sc-retention-field') {
    state.scRetentionDraft[id] = value;
    return true;
  }
  if (act === 'sc-retention-type-toggle') {
    const el = document.querySelector(`[data-wf="sc-retention-type-toggle"][data-id="${id}"]`);
    const checked = !!(el && el.checked);
    const d = state.scRetentionDraft;
    d.appliesToReportTypes = checked ? [...new Set([...d.appliesToReportTypes, id])] : d.appliesToReportTypes.filter((t) => t !== id);
    return true;
  }
  if (act === 'sc-retention-go') {
    const d = state.scRetentionDraft;
    if (!d.jurisdiction.trim()) {
      toast('Jurisdiction is required.');
      return true;
    }
    const retentionYears = Number(d.retentionYears);
    if (!Number.isInteger(retentionYears) || retentionYears < 1) {
      toast('Retention years must be a whole number of at least 1.');
      return true;
    }
    state.wf.saving.scRetention = true;
    doRerender();
    Api.adherenceComplianceApi(`/v1/compliance/retention-policies/${encodeURIComponent(d.jurisdiction.trim())}`, {
      method: 'PUT',
      body: { retentionYears, appliesToReportTypes: d.appliesToReportTypes.length ? d.appliesToReportTypes : undefined },
    })
      .then(() => {
        state.wf.saving.scRetention = false;
        state.drawer = null;
        state.wf.retentionPolicies = null;
        toast('Retention policy saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.scRetention = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
