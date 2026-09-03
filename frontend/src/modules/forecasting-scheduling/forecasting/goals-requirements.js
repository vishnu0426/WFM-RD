/* Forecasting > Goals & Requirements — service level targets, per org unit.
   Wired to forecasting-service. GET returns platform defaults (isDefault:
   true) when a tenant never configured one for that org unit — not a 404 —
   so this screen always has something real to show. */
import { $, esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty } from '../../identity-org/shared/ui.js';
import { loadOrgUnits } from '../../identity-org/shared/loaders.js';
import * as ForecastingApi from '../../forecasting/api.js';

const isOk = (x) => Array.isArray(x);
const pct = (fraction) => (fraction == null ? '' : (Number(fraction) * 100).toFixed(1));

async function loadTarget(state, orgUnitId) {
  state.wf.slTargets = state.wf.slTargets || {};
  try {
    state.wf.slTargets[orgUnitId] = await ForecastingApi.getServiceLevelTarget(orgUnitId);
  } catch (err) {
    state.wf.slTargets[orgUnitId] = { error: errMsg(err) };
  }
  doRerender();
}

export function render(state) {
  if (!isOk(state.data.orgUnits)) loadOrgUnits(state);
  const orgUnits = isOk(state.data.orgUnits) ? state.data.orgUnits : [];
  if (state.goalsOu === undefined && orgUnits.length) state.goalsOu = orgUnits[0].id;

  if (!orgUnits.length) {
    return `${pageHead("Goals & Requirements", "Service level targets, per org unit — wired to forecasting-service.", "")}
      <div class="panel">${empty("No org units yet.")}</div>`;
  }

  state.wf.slTargets = state.wf.slTargets || {};
  const target = state.wf.slTargets[state.goalsOu];
  if (target === undefined) loadTarget(state, state.goalsOu);

  const body = !target
    ? `<div class="skel" style="height:24px"></div>`
    : target.error ? `<p class="muted">${esc(target.error)}</p>`
    : `<div class="grid-2">
        <div class="field"><label>Target service level (%)</label><input id="glr-sl" type="number" min="0.1" max="100" step="0.1" value="${pct(target.targetServiceLevel)}" /></div>
        <div class="field"><label>Target answer time (seconds)</label><input id="glr-at" type="number" min="1" value="${target.targetAnswerTimeSeconds}" /></div>
        <div class="field"><label>Max occupancy (%)</label><input id="glr-mo" type="number" min="0.1" max="100" step="0.1" value="${pct(target.maxOccupancy)}" /></div>
      </div>
      <p class="hint" style="margin-top:10px">${target.isDefault ? "Showing platform defaults — this org unit has no target configured yet." : "Tenant-configured target for this org unit."}</p>
      <div class="actions" style="margin-top:14px"><button class="btn btn-primary" data-wf="glr-save" ${state.wf.saving.glr ? "disabled" : ""}>${state.wf.saving.glr ? "Saving…" : "Save"}</button></div>`;

  return `
    ${pageHead("Goals & Requirements", "Service level targets, per org unit — wired to forecasting-service.", "")}
    <div class="field" style="max-width:360px;margin-bottom:14px">
      <label>Org unit</label>
      <select data-wf="glr-ou">${orgUnits.map((o) => `<option value="${o.id}" ${o.id === state.goalsOu ? "selected" : ""}>${"— ".repeat(o.depth)}${esc(o.name)}</option>`).join("")}</select>
    </div>
    ${sec("Target", body)}`;
}

export function handle(state, act, id, value) {
  if (act === "glr-ou") { state.goalsOu = value; return true; }

  if (act === "glr-save") {
    const slRaw = $("#glr-sl")?.value;
    const atRaw = $("#glr-at")?.value;
    const moRaw = $("#glr-mo")?.value;
    const targetServiceLevel = Number(slRaw) / 100;
    const targetAnswerTimeSeconds = Number(atRaw);
    const maxOccupancy = Number(moRaw) / 100;
    if (!slRaw || targetServiceLevel <= 0 || targetServiceLevel > 1) { toast("Target service level must be between 0.1% and 100%."); return true; }
    if (!atRaw || targetAnswerTimeSeconds <= 0) { toast("Target answer time must be greater than 0."); return true; }
    if (!moRaw || maxOccupancy <= 0 || maxOccupancy > 1) { toast("Max occupancy must be between 0.1% and 100%."); return true; }
    state.wf.saving.glr = true;
    doRerender();
    ForecastingApi.putServiceLevelTarget(state.goalsOu, { targetServiceLevel, targetAnswerTimeSeconds, maxOccupancy })
      .then((updated) => {
        state.wf.saving.glr = false;
        state.wf.slTargets[state.goalsOu] = updated;
        toast("Target saved.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.glr = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
