/* Work Rules > Project Rules — wired to scheduling-service. */
import { esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, drawerShell } from '../../identity-org/shared/ui.js';
import * as SchedulingApi from '../../scheduling/api.js';

const isOk = (x) => Array.isArray(x);

async function loadProjectRules(state) {
  if (state.wf.projectRules) return state.wf.projectRules;
  try {
    state.wf.projectRules = await SchedulingApi.listProjectRules();
  } catch (err) {
    state.wf.projectRules = { error: errMsg(err) };
  }
  doRerender();
  return state.wf.projectRules;
}

export function render(state) {
  if (!state.wf.projectRules) loadProjectRules(state);
  const rules = state.wf.projectRules;

  const body = !rules
    ? `<div class="skel" style="height:24px"></div>`
    : !isOk(rules) ? `<p class="muted">${esc(rules.error)}</p>`
    : `<table class="data"><thead><tr><th>Name</th><th>Max consecutive days</th><th>Min rest (hrs)</th><th>Shift length (min)</th><th>OT allowed</th><th></th></tr></thead><tbody>${
        rules.map((r) => `<tr>
          <td><b>${esc(r.name)}</b>${r.description ? `<div class="muted">${esc(r.description)}</div>` : ""}</td>
          <td class="mono">${r.maxConsecutiveWorkingDays}</td>
          <td class="mono">${r.minRestHoursBetweenShifts}</td>
          <td class="mono">${r.minShiftLengthMinutes}–${r.maxShiftLengthMinutes ?? "∞"}</td>
          <td>${r.allowsOvertime ? "Yes" : "No"}</td>
          <td><button class="btn btn-sm" data-wf="pr-edit" data-id="${r.id}">Edit</button> <button class="btn btn-sm" data-wf="pr-delete" data-id="${r.id}">Delete</button></td>
        </tr>`).join("") || `<tr><td colspan="6" class="muted">No project rules yet.</td></tr>`
      }</tbody></table>`;

  return `
    ${pageHead("Project Rules", "Wired to scheduling-service.", `<button class="btn btn-primary" data-wf="pr-open">+ New project rule</button>`)}
    ${sec("Rules", body)}`;
}

function draftFor(editing) {
  return {
    name: (editing && editing.name) || "",
    description: (editing && editing.description) || "",
    maxConsecutiveWorkingDays: editing ? editing.maxConsecutiveWorkingDays : 6,
    minRestHoursBetweenShifts: editing ? editing.minRestHoursBetweenShifts : 10,
    minShiftLengthMinutes: editing ? editing.minShiftLengthMinutes : 240,
    maxShiftLengthMinutes: editing && editing.maxShiftLengthMinutes != null ? editing.maxShiftLengthMinutes : "",
    allowsOvertime: editing ? !!editing.allowsOvertime : true,
  };
}

export function renderDrawer(state) {
  if (state.drawer !== "pr") return "";
  const editing = state.editPrTarget;
  // Every field lives in state.prDraft and this drawer always renders from
  // it — never straight from `editing` or the raw DOM — so a re-render
  // landing mid-edit (a list refetch, another loader resolving) can't
  // silently revert an unsaved change. See campaigns.js's own note for the
  // reproduced bug this pattern fixes.
  const d = state.prDraft || draftFor(editing);
  return drawerShell(editing ? "Edit project rule" : "Create project rule", editing ? "PATCH /v1/scheduling/project-rules/:id" : "POST /v1/scheduling/project-rules",
    `<div class="field"><label>Name</label><input data-wf="pr-field" data-id="name" value="${esc(d.name)}" /></div>
     <div class="field" style="margin-top:10px"><label>Description</label><input data-wf="pr-field" data-id="description" value="${esc(d.description)}" /></div>
     <div class="grid-2" style="margin-top:10px">
       <div class="field"><label>Max consecutive working days</label><input data-wf="pr-field" data-id="maxConsecutiveWorkingDays" type="number" min="1" value="${d.maxConsecutiveWorkingDays}" /></div>
       <div class="field"><label>Min rest hours between shifts</label><input data-wf="pr-field" data-id="minRestHoursBetweenShifts" type="number" min="0" step="0.5" value="${d.minRestHoursBetweenShifts}" /></div>
       <div class="field"><label>Min shift length (minutes)</label><input data-wf="pr-field" data-id="minShiftLengthMinutes" type="number" min="1" value="${d.minShiftLengthMinutes}" /></div>
       <div class="field"><label>Max shift length (minutes, optional)</label><input data-wf="pr-field" data-id="maxShiftLengthMinutes" type="number" min="1" value="${d.maxShiftLengthMinutes}" /></div>
     </div>
     <div class="field" style="margin-top:10px"><label><input type="checkbox" data-wf="pr-ot-toggle" ${d.allowsOvertime ? "checked" : ""} style="width:auto;margin-right:6px" />Allows overtime</label></div>`,
    `<button class="btn" data-wf="close-drawer">Cancel</button>`,
    `<button class="btn btn-primary" data-wf="${editing ? "pr-edit-go" : "pr-go"}" ${editing ? `data-id="${editing.id}"` : ""} ${state.wf.saving.pr ? "disabled" : ""}>${state.wf.saving.pr ? "Saving…" : editing ? "Save" : "Create"}</button>`);
}

export function handle(state, act, id, value) {
  if (act === "pr-open") { state.editPrTarget = null; state.prDraft = draftFor(null); state.drawer = "pr"; return true; }
  if (act === "pr-edit") {
    state.editPrTarget = (isOk(state.wf.projectRules) ? state.wf.projectRules : []).find((r) => r.id === id);
    state.prDraft = draftFor(state.editPrTarget);
    state.drawer = "pr";
    return true;
  }
  if (act === "pr-field") { state.prDraft[id] = value; return true; }
  if (act === "pr-ot-toggle") { state.prDraft.allowsOvertime = !state.prDraft.allowsOvertime; return true; }

  if (act === "pr-go" || act === "pr-edit-go") {
    const d = state.prDraft || draftFor(null);
    const name = (d.name || "").trim();
    const description = (d.description || "").trim() || undefined;
    const maxConsecutiveWorkingDays = Number(d.maxConsecutiveWorkingDays || 0);
    const minRestHoursBetweenShifts = Number(d.minRestHoursBetweenShifts || 0);
    const minShiftLengthMinutes = Number(d.minShiftLengthMinutes || 0);
    const maxShiftLengthMinutes = d.maxShiftLengthMinutes !== "" && d.maxShiftLengthMinutes != null ? Number(d.maxShiftLengthMinutes) : undefined;
    const allowsOvertime = !!d.allowsOvertime;
    if (!name) { toast("Name is required."); return true; }
    if (!maxConsecutiveWorkingDays || !minShiftLengthMinutes) { toast("Max consecutive days and min shift length must be greater than 0."); return true; }
    state.wf.saving.pr = true;
    doRerender();
    const body = {
      name, description,
      maxConsecutiveWorkingDays, minRestHoursBetweenShifts, minShiftLengthMinutes, maxShiftLengthMinutes, allowsOvertime,
    };
    const call = act === "pr-go" ? SchedulingApi.createProjectRule(body) : SchedulingApi.updateProjectRule(id, body);
    call
      .then(() => {
        state.wf.saving.pr = false;
        state.wf.projectRules = null;
        state.prDraft = null;
        state.drawer = null;
        toast(act === "pr-go" ? "Project rule created." : "Project rule saved.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.pr = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }

  if (act === "pr-delete") {
    if (!confirm("Delete this project rule?")) return true;
    SchedulingApi.deleteProjectRule(id)
      .then(() => {
        state.wf.projectRules = null;
        toast("Project rule deleted.");
        doRerender();
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
