/* System Configuration → WFM Defaults — week start day / day boundary.
   Same fields Platform Admin onboarding already writes cross-tenant
   (POST/GET /v1/tenants/:id/wfm-defaults); this is the tenant's own
   self-service consumer of the identical GET/PUT /v1/tenant-settings
   /wfm-defaults route, for ongoing edits after onboarding. */
import { Api } from '../../../core/api.js';
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec } from '../shared/ui.js';
import { loadSettings } from '../shared/loaders.js';

const WEEK_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function emptyDraft(s) {
  return { weekStartDay: s.weekStartDay || WEEK_DAYS[1], dayBoundary: s.dayBoundary || '' };
}

function emptyWorkforceDraft(s) {
  const n = (v) => (v == null ? '' : String(v));
  return {
    schedulingIntervalMinutes: n(s.schedulingIntervalMinutes),
    planningPeriodWeeks: n(s.planningPeriodWeeks),
    defaultShiftDurationHours: n(s.defaultShiftDurationHours),
    forecastingIntervalMinutes: n(s.forecastingIntervalMinutes),
    historicalDataWindowWeeks: n(s.historicalDataWindowWeeks),
    forecastingPlanningHorizonWeeks: n(s.forecastingPlanningHorizonWeeks),
    attendanceGracePeriodMinutes: n(s.attendanceGracePeriodMinutes),
  };
}

export function render(state) {
  if (!state.wf.settings) {
    loadSettings(state);
    return pageHead('WFM Defaults', 'Loading…', '') + `<div class="panel"><div style="padding:16px"><div class="skel" style="height:24px"></div></div></div>`;
  }
  if (!state.scWfmDraft) state.scWfmDraft = emptyDraft(state.wf.settings);
  if (!state.scWorkforceDraft) state.scWorkforceDraft = emptyWorkforceDraft(state.wf.settings);
  const d = state.scWfmDraft;
  const saved = emptyDraft(state.wf.settings);
  const dirty = JSON.stringify(d) !== JSON.stringify(saved);
  const saving = state.wf.saving.scWfm;
  const wd = state.scWorkforceDraft;
  const savedWd = emptyWorkforceDraft(state.wf.settings);
  const wdDirty = JSON.stringify(wd) !== JSON.stringify(savedWd);
  const wdSaving = state.wf.saving.scWorkforce;
  return `
    ${pageHead('WFM Defaults', 'Week boundaries used by workforce scheduling.', `
      <button class="btn" data-wf="sc-wfm-revert" ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-primary" data-wf="sc-wfm-save" ${dirty && !saving ? '' : 'disabled'}>${saving ? 'Saving…' : 'Save'}</button>`)}
    ${sec('Week configuration', `
      <div class="grid-2">
        <div class="field"><label>Week start day</label>
          <select data-wf="sc-wfm-field" data-id="weekStartDay">${WEEK_DAYS.map((w) => `<option value="${w}" ${d.weekStartDay === w ? 'selected' : ''}>${w[0].toUpperCase()}${w.slice(1)}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Day boundary</label><input data-wf="sc-wfm-field" data-id="dayBoundary" type="time" value="${esc(d.dayBoundary)}" /></div>
      </div>
      <p class="hint" style="margin-top:10px">Day boundary is the clock time a WFM "day" resets at, for shifts crossing midnight.</p>
    `, `<span class="meta">GET/PUT /v1/tenant-settings/wfm-defaults</span>`)}
    ${sec('Scheduling / Forecasting / Attendance defaults', `
      <p class="hint" style="margin:0 0 10px"><b>BACKEND GAP:</b> these save real, validated values, but scheduling-service/forecasting-service/attendance-leave-service cannot read this table yet (deliberate per-service schema isolation, no gRPC RPC exposes it to them today) — so changing these numbers does not yet affect scheduling, forecasting, or attendance output. Persisted for when that cross-service wiring exists.</p>
      <div class="grid-2">
        <div class="field"><label>Scheduling interval (minutes)</label>
          <select data-wf="sc-workforce-field" data-id="schedulingIntervalMinutes">${selectMinutes(wd.schedulingIntervalMinutes)}</select>
        </div>
        <div class="field"><label>Planning period (weeks)</label><input data-wf="sc-workforce-field" data-id="planningPeriodWeeks" type="number" min="1" max="52" value="${esc(wd.planningPeriodWeeks)}" /></div>
      </div>
      <div class="grid-2" style="margin-top:10px">
        <div class="field"><label>Default shift duration (hours)</label><input data-wf="sc-workforce-field" data-id="defaultShiftDurationHours" type="number" min="1" max="24" step="0.5" value="${esc(wd.defaultShiftDurationHours)}" /></div>
        <div class="field"><label>Forecasting interval (minutes)</label>
          <select data-wf="sc-workforce-field" data-id="forecastingIntervalMinutes">${selectMinutes(wd.forecastingIntervalMinutes)}</select>
        </div>
      </div>
      <div class="grid-2" style="margin-top:10px">
        <div class="field"><label>Historical data window (weeks)</label><input data-wf="sc-workforce-field" data-id="historicalDataWindowWeeks" type="number" min="1" max="104" value="${esc(wd.historicalDataWindowWeeks)}" /></div>
        <div class="field"><label>Forecasting planning horizon (weeks)</label><input data-wf="sc-workforce-field" data-id="forecastingPlanningHorizonWeeks" type="number" min="1" max="52" value="${esc(wd.forecastingPlanningHorizonWeeks)}" /></div>
      </div>
      <div class="field" style="margin-top:10px;max-width:calc(50% - 6px)"><label>Attendance grace period (minutes)</label><input data-wf="sc-workforce-field" data-id="attendanceGracePeriodMinutes" type="number" min="0" max="60" value="${esc(wd.attendanceGracePeriodMinutes)}" /></div>
      <div class="actions" style="margin-top:10px">
        <button class="btn" data-wf="sc-workforce-revert" ${wdDirty ? '' : 'disabled'}>Revert</button>
        <button class="btn btn-primary" data-wf="sc-workforce-save" ${wdDirty && !wdSaving ? '' : 'disabled'}>${wdSaving ? 'Saving…' : 'Save'}</button>
      </div>
    `, `<span class="meta">GET/PUT /v1/tenant-settings/workforce-defaults</span>`)}`;
}

function selectMinutes(current) {
  const opts = ['', '15', '30', '60'];
  return opts.map((v) => `<option value="${v}" ${current === v ? 'selected' : ''}>${v === '' ? '—' : v}</option>`).join('');
}

export function handle(state, act, id, value) {
  if (act === 'sc-wfm-field') {
    state.scWfmDraft = state.scWfmDraft || emptyDraft(state.wf.settings);
    state.scWfmDraft[id] = value;
    return true;
  }
  if (act === 'sc-wfm-revert') {
    state.scWfmDraft = emptyDraft(state.wf.settings);
    return true;
  }
  if (act === 'sc-wfm-save') {
    const d = state.scWfmDraft;
    state.wf.saving.scWfm = true;
    doRerender();
    Api.rootApi('/v1/tenant-settings/wfm-defaults', {
      method: 'PUT',
      body: { weekStartDay: d.weekStartDay, dayBoundary: d.dayBoundary.trim() || undefined },
    })
      .then((updated) => {
        state.wf.saving.scWfm = false;
        state.wf.settings = updated;
        state.scWfmDraft = emptyDraft(updated);
        toast('WFM defaults saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.scWfm = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === 'sc-workforce-field') {
    state.scWorkforceDraft = state.scWorkforceDraft || emptyWorkforceDraft(state.wf.settings);
    state.scWorkforceDraft[id] = value;
    return true;
  }
  if (act === 'sc-workforce-revert') {
    state.scWorkforceDraft = emptyWorkforceDraft(state.wf.settings);
    return true;
  }
  if (act === 'sc-workforce-save') {
    const wd = state.scWorkforceDraft;
    const n = (v) => (v === '' ? undefined : Number(v));
    state.wf.saving.scWorkforce = true;
    doRerender();
    Api.rootApi('/v1/tenant-settings/workforce-defaults', {
      method: 'PUT',
      body: {
        schedulingIntervalMinutes: n(wd.schedulingIntervalMinutes),
        planningPeriodWeeks: n(wd.planningPeriodWeeks),
        defaultShiftDurationHours: n(wd.defaultShiftDurationHours),
        forecastingIntervalMinutes: n(wd.forecastingIntervalMinutes),
        historicalDataWindowWeeks: n(wd.historicalDataWindowWeeks),
        forecastingPlanningHorizonWeeks: n(wd.forecastingPlanningHorizonWeeks),
        attendanceGracePeriodMinutes: n(wd.attendanceGracePeriodMinutes),
      },
    })
      .then((updated) => {
        state.wf.saving.scWorkforce = false;
        state.wf.settings = updated;
        state.scWorkforceDraft = emptyWorkforceDraft(updated);
        toast('Workforce defaults saved.');
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.scWorkforce = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
