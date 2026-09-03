/* System Configuration → General — branding/display defaults. Real backend
   (GET/PUT /v1/tenant-settings, PUT /general), but timezone/locale are NOT
   consumed by any WFM computation today (the real per-org-unit timezone
   used by Calendar/Scheduling is WorkingTimeCalendar.timezone) — disclosed
   inline rather than implying this drives downstream behavior. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec } from '../shared/ui.js';
import { loadSettings } from '../shared/loaders.js';

function emptyDraft(s) {
  return { timezone: s.timezone || '', locale: s.locale || '', brandLogoUrl: s.brandLogoUrl || '' };
}

export function render(state) {
  if (!state.wf.settings) {
    loadSettings(state);
    return pageHead('General', 'Loading…', '') + `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  }
  if (!state.scGeneralDraft) state.scGeneralDraft = emptyDraft(state.wf.settings);
  const d = state.scGeneralDraft;
  const saved = emptyDraft(state.wf.settings);
  const dirty = JSON.stringify(d) !== JSON.stringify(saved);
  const saving = state.wf.saving.scGeneral;
  return `
    ${pageHead('General', 'Branding and display defaults for this tenant.', `
      <button class="btn" data-wf="sc-general-revert" ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-primary" data-wf="sc-general-save" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>`)}
    ${sec('Display defaults', `
      <p class="hint" style="margin:0 0 10px">Timezone and locale are saved here but not yet consumed by any WFM computation — Calendar/Scheduling use each organization unit's own timezone instead (Organization → Hierarchy). This just controls what's displayed as this tenant's nominal default.</p>
      <div class="field"><label>Timezone</label><input data-wf="sc-general-field" data-id="timezone" placeholder="e.g. America/New_York" value="${esc(d.timezone)}" /></div>
      <div class="field" style="margin-top:10px"><label>Locale</label><input data-wf="sc-general-field" data-id="locale" placeholder="e.g. en-US" value="${esc(d.locale)}" /></div>
      <div class="field" style="margin-top:10px"><label>Brand logo URL</label><input data-wf="sc-general-field" data-id="brandLogoUrl" placeholder="https://…" value="${esc(d.brandLogoUrl)}" /></div>
    `, `<span class="meta">GET/PUT /v1/tenant-settings/general</span>`)}`;
}

export function handle(state, act, id, value) {
  if (act === 'sc-general-field') {
    state.scGeneralDraft = state.scGeneralDraft || emptyDraft(state.wf.settings);
    state.scGeneralDraft[id] = value;
    return true;
  }
  if (act === 'sc-general-revert') {
    state.scGeneralDraft = emptyDraft(state.wf.settings);
    return true;
  }
  if (act === 'sc-general-save') {
    const d = state.scGeneralDraft;
    state.wf.saving.scGeneral = true;
    doRerender();
    Api.rootApi('/v1/tenant-settings/general', {
      method: 'PUT',
      body: {
        timezone: d.timezone.trim() || undefined,
        locale: d.locale.trim() || undefined,
        brandLogoUrl: d.brandLogoUrl.trim() || null,
      },
    })
      .then((updated) => {
        state.wf.saving.scGeneral = false;
        state.wf.settings = updated;
        state.scGeneralDraft = emptyDraft(updated);
        toast('General settings saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.scGeneral = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
