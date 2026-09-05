/* Forecasting > Backlog Age Template — reusable warning/critical age
   thresholds. Wired to forecasting-service. */
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, drawerShell } from '../../identity-org/shared/ui.js';
import * as ForecastingApi from '../../forecasting/api.js';

const isOk = (x) => Array.isArray(x);

async function loadTemplates(state) {
  if (state.wf.backlogAgeTemplates) return state.wf.backlogAgeTemplates;
  try {
    state.wf.backlogAgeTemplates = await ForecastingApi.listBacklogAgeTemplates();
  } catch (err) {
    state.wf.backlogAgeTemplates = { error: errMsg(err) };
  }
  doRerender();
  return state.wf.backlogAgeTemplates;
}

export function render(state) {
  if (!state.wf.backlogAgeTemplates) loadTemplates(state);
  const templates = state.wf.backlogAgeTemplates;

  const body = !templates
    ? `<div class="skel" style="height:24px"></div>`
    : !isOk(templates) ? `<p class="muted">${esc(templates.error)}</p>`
    : `<table class="data"><thead><tr><th>Name</th><th>Warning after</th><th>Critical after</th><th></th></tr></thead><tbody>${
        templates.map((t) => `<tr>
          <td><b>${esc(t.name)}</b>${t.description ? `<div class="muted">${esc(t.description)}</div>` : ""}</td>
          <td class="mono">${t.warningThresholdMinutes} min</td>
          <td class="mono">${t.criticalThresholdMinutes} min</td>
          <td><button class="btn btn-sm" data-wf="bat-edit" data-id="${t.id}">Edit</button> <button class="btn btn-sm" data-wf="bat-delete" data-id="${t.id}">Delete</button></td>
        </tr>`).join("") || `<tr><td colspan="4" class="muted">No templates yet.</td></tr>`
      }</tbody></table>`;

  return `
    ${pageHead("Backlog Age Template", "Warning/critical age thresholds, reusable across backlog snapshots — wired to forecasting-service.", `<button class="btn btn-primary" data-wf="bat-open">+ New template</button>`)}
    ${sec("Templates", body)}`;
}

function draftFor(editing) {
  return {
    name: (editing && editing.name) || "",
    description: (editing && editing.description) || "",
    warningThresholdMinutes: editing ? editing.warningThresholdMinutes : 60,
    criticalThresholdMinutes: editing ? editing.criticalThresholdMinutes : 180,
  };
}

export function renderDrawer(state) {
  if (state.drawer !== "bat") return "";
  const editing = state.editBatTarget;
  // Rendered from state.batDraft, live-captured on every field change — see
  // campaigns.js's own note for the reproduced silently-reverted-edit bug
  // this avoids (a re-render landing between an edit and clicking Save).
  const d = state.batDraft || draftFor(editing);
  return drawerShell(editing ? "Edit backlog age template" : "Create backlog age template", editing ? "Update this template's thresholds." : "Define warning/critical age thresholds to reuse across backlog snapshots.",
    `<div class="field"><label>Name</label><input data-wf="bat-field" data-id="name" value="${esc(d.name)}" /></div>
     <div class="field" style="margin-top:10px"><label>Description</label><input data-wf="bat-field" data-id="description" value="${esc(d.description)}" /></div>
     <div class="grid-2" style="margin-top:10px">
       <div class="field"><label>Warning threshold (minutes)</label><input data-wf="bat-field" data-id="warningThresholdMinutes" type="number" min="1" value="${d.warningThresholdMinutes}" /></div>
       <div class="field"><label>Critical threshold (minutes)</label><input data-wf="bat-field" data-id="criticalThresholdMinutes" type="number" min="1" value="${d.criticalThresholdMinutes}" /></div>
     </div>`,
    `<button class="btn" data-wf="close-drawer">Cancel</button>`,
    `<button class="btn btn-primary" data-wf="${editing ? "bat-edit-go" : "bat-go"}" ${editing ? `data-id="${editing.id}"` : ""} ${state.wf.saving.bat ? "disabled" : ""}>${state.wf.saving.bat ? "Saving…" : editing ? "Save" : "Create"}</button>`);
}

export function handle(state, act, id, value) {
  if (act === "bat-open") { state.editBatTarget = null; state.batDraft = draftFor(null); state.drawer = "bat"; return true; }
  if (act === "bat-edit") {
    state.editBatTarget = (isOk(state.wf.backlogAgeTemplates) ? state.wf.backlogAgeTemplates : []).find((t) => t.id === id);
    state.batDraft = draftFor(state.editBatTarget);
    state.drawer = "bat";
    return true;
  }
  if (act === "bat-field") { state.batDraft[id] = value; return true; }

  if (act === "bat-go" || act === "bat-edit-go") {
    const d = state.batDraft || draftFor(null);
    const name = (d.name || "").trim();
    const description = (d.description || "").trim() || undefined;
    const warningThresholdMinutes = Number(d.warningThresholdMinutes || 0);
    const criticalThresholdMinutes = Number(d.criticalThresholdMinutes || 0);
    if (!name) { toast("Name is required."); return true; }
    if (!warningThresholdMinutes || !criticalThresholdMinutes) { toast("Both thresholds are required."); return true; }
    if (criticalThresholdMinutes <= warningThresholdMinutes) { toast("Critical threshold must be greater than warning threshold."); return true; }
    state.wf.saving.bat = true;
    doRerender();
    const body = { name, description, warningThresholdMinutes, criticalThresholdMinutes };
    const call = act === "bat-go" ? ForecastingApi.createBacklogAgeTemplate(body) : ForecastingApi.updateBacklogAgeTemplate(id, body);
    call
      .then(() => {
        state.wf.saving.bat = false;
        state.wf.backlogAgeTemplates = null;
        state.batDraft = null;
        state.drawer = null;
        toast(act === "bat-go" ? "Template created." : "Template saved.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.bat = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === "bat-delete") {
    if (!confirm("Delete this backlog age template?")) return true;
    ForecastingApi.deleteBacklogAgeTemplate(id)
      .then(() => {
        state.wf.backlogAgeTemplates = null;
        toast("Template deleted.");
        doRerender();
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
