/* Forecasting > Backlog Age — recorded backlog snapshots (item count +
   oldest item age), per org unit, optionally scored against a Backlog Age
   Template's thresholds. Wired to forecasting-service. Record + list only —
   a snapshot is a point-in-time record, never edited or deleted. */
import { $, esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, fmtDt, drawerShell } from '../../identity-org/shared/ui.js';
import { loadOrgUnits } from '../../identity-org/shared/loaders.js';
import * as ForecastingApi from '../../forecasting/api.js';

const isOk = (x) => Array.isArray(x);

async function loadSnapshots(state, orgUnitId) {
  state.wf.backlogSnapshots = state.wf.backlogSnapshots || {};
  try {
    state.wf.backlogSnapshots[orgUnitId] = await ForecastingApi.listBacklogSnapshots(orgUnitId);
  } catch (err) {
    state.wf.backlogSnapshots[orgUnitId] = { error: errMsg(err) };
  }
  doRerender();
}

async function loadTemplates(state) {
  if (state.wf.backlogAgeTemplates) return;
  try {
    state.wf.backlogAgeTemplates = await ForecastingApi.listBacklogAgeTemplates();
  } catch (err) {
    state.wf.backlogAgeTemplates = { error: errMsg(err) };
  }
  doRerender();
}

function severity(ageMinutes, template) {
  if (!template) return "";
  if (ageMinutes >= template.criticalThresholdMinutes) return `<span class="badge badge-danger"><span class="pip"></span>Critical</span>`;
  if (ageMinutes >= template.warningThresholdMinutes) return `<span class="badge badge-warn"><span class="pip"></span>Warning</span>`;
  return `<span class="badge badge-ok"><span class="pip"></span>OK</span>`;
}

export function render(state) {
  if (!isOk(state.data.orgUnits)) loadOrgUnits(state);
  const orgUnits = isOk(state.data.orgUnits) ? state.data.orgUnits : [];
  if (state.backlogOu === undefined && orgUnits.length) state.backlogOu = orgUnits[0].id;
  loadTemplates(state);
  const templates = isOk(state.wf.backlogAgeTemplates) ? state.wf.backlogAgeTemplates : [];

  if (!orgUnits.length) {
    return `${pageHead("Backlog Age", "Point-in-time backlog snapshots, per org unit — wired to forecasting-service.", "")}
      <div class="panel">${empty("No org units yet.")}</div>`;
  }

  state.wf.backlogSnapshots = state.wf.backlogSnapshots || {};
  const rows = state.wf.backlogSnapshots[state.backlogOu];
  if (rows === undefined) loadSnapshots(state, state.backlogOu);

  const body = !rows
    ? `<div class="skel" style="height:24px"></div>`
    : !isOk(rows) ? `<p class="muted">${esc(rows.error)}</p>`
    : `<table class="data"><thead><tr><th>Recorded</th><th>Items</th><th>Oldest item age</th><th>Template</th><th>Status</th></tr></thead><tbody>${
        rows.map((r) => {
          const t = templates.find((x) => x.id === r.templateId);
          return `<tr><td class="muted">${fmtDt(r.recordedAt)}</td><td class="mono">${r.itemCount}</td><td class="mono">${r.oldestItemAgeMinutes} min</td><td>${t ? esc(t.name) : "—"}</td><td>${severity(r.oldestItemAgeMinutes, t)}</td></tr>`;
        }).join("") || `<tr><td colspan="5" class="muted">No snapshots recorded yet.</td></tr>`
      }</tbody></table>`;

  return `
    ${pageHead("Backlog Age", "Point-in-time backlog snapshots, per org unit — wired to forecasting-service.", `<button class="btn btn-primary" data-wf="bs-open">+ Record snapshot</button>`)}
    <div class="field" style="max-width:360px;margin-bottom:14px">
      <label>Org unit</label>
      <select data-wf="bs-ou">${orgUnits.map((o) => `<option value="${o.id}" ${o.id === state.backlogOu ? "selected" : ""}>${"— ".repeat(o.depth)}${esc(o.name)}</option>`).join("")}</select>
    </div>
    ${sec("Recent snapshots", body)}`;
}

export function renderDrawer(state) {
  if (state.drawer !== "bs") return "";
  const templates = isOk(state.wf.backlogAgeTemplates) ? state.wf.backlogAgeTemplates : [];
  return drawerShell("Record backlog snapshot", "POST /v1/forecasting/backlog-snapshots",
    `<div class="grid-2">
       <div class="field"><label>Item count</label><input id="bs-count" type="number" min="0" /></div>
       <div class="field"><label>Oldest item age (minutes)</label><input id="bs-age" type="number" min="0" /></div>
       <div class="field full"><label>Template (optional)</label><select id="bs-template"><option value="">None</option>${templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></div>
     </div>`,
    `<button class="btn" data-wf="close-drawer">Cancel</button>`,
    `<button class="btn btn-primary" data-wf="bs-go" ${state.wf.saving.bs ? "disabled" : ""}>${state.wf.saving.bs ? "Recording…" : "Record"}</button>`);
}

export function handle(state, act, id, value) {
  if (act === "bs-ou") { state.backlogOu = value; return true; }
  if (act === "bs-open") { state.drawer = "bs"; return true; }

  if (act === "bs-go") {
    const itemCount = Number($("#bs-count")?.value);
    const oldestItemAgeMinutes = Number($("#bs-age")?.value);
    const templateId = $("#bs-template")?.value || undefined;
    if (isNaN(itemCount) || itemCount < 0) { toast("Item count is required."); return true; }
    if (isNaN(oldestItemAgeMinutes) || oldestItemAgeMinutes < 0) { toast("Oldest item age is required."); return true; }
    state.wf.saving.bs = true;
    doRerender();
    ForecastingApi.recordBacklogSnapshot({ orgUnitId: state.backlogOu, templateId, itemCount, oldestItemAgeMinutes })
      .then(() => {
        state.wf.saving.bs = false;
        state.wf.backlogSnapshots[state.backlogOu] = undefined;
        state.drawer = null;
        toast("Snapshot recorded.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.bs = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  return false;
}
