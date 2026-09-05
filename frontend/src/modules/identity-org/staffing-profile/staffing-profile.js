/* Staffing Profile — wired to scheduling-service (:8100). Real
   ShiftTemplate + StaffingProfile CRUD/PATCH, plus a lightweight WorkPattern
   tab (this service's real model — a named sequence of shift-template-or-
   day-off slots) fulfilling the disclosure work-rules.js's own "wired once
   the Staffing Profile tab's own pass reaches it" note already promised. */
import { $, esc, errMsg } from '../../../core/dom.js';
import { doRerender } from '../../../app/rerender.js';
import { toast } from '../../../app/toast.js';
import { pageHead, sec, empty, drawerShell } from '../shared/ui.js';
import * as SchedulingApi from '../../scheduling/api.js';

async function loadShiftTemplates(state) {
  if (state.wf.shiftTemplates) return state.wf.shiftTemplates;
  try {
    state.wf.shiftTemplates = await SchedulingApi.listShiftTemplates();
  } catch (err) {
    state.wf.shiftTemplates = { error: errMsg(err) };
  }
  doRerender();
  return state.wf.shiftTemplates;
}

async function loadStaffingProfiles(state) {
  if (state.wf.staffingProfiles) return state.wf.staffingProfiles;
  try {
    state.wf.staffingProfiles = await SchedulingApi.listStaffingProfiles();
  } catch (err) {
    state.wf.staffingProfiles = { error: errMsg(err) };
  }
  doRerender();
  return state.wf.staffingProfiles;
}

async function loadWorkPatterns(state) {
  if (state.wf.workPatterns) return state.wf.workPatterns;
  try {
    state.wf.workPatterns = await SchedulingApi.listWorkPatterns();
  } catch (err) {
    state.wf.workPatterns = { error: errMsg(err) };
  }
  doRerender();
  return state.wf.workPatterns;
}

const isOk = (x) => Array.isArray(x);

export function render(state) {
  if (!state.wf.staffingProfiles) loadStaffingProfiles(state);
  if (!state.wf.shiftTemplates) loadShiftTemplates(state);
  const spTab = state.staffingSubTab || "profiles";
  const templates = isOk(state.wf.shiftTemplates) ? state.wf.shiftTemplates : [];
  const templateName = (id) => (templates.find((t) => t.id === id) || {}).name || id;

  let body = "";
  if (spTab === "profiles") {
    const profiles = state.wf.staffingProfiles;
    if (state.spId === undefined && isOk(profiles) && profiles.length) state.spId = profiles[0].id;
    const p = isOk(profiles) ? profiles.find((x) => x.id === state.spId) : undefined;
    body = `
      <div class="split">
        <div class="split-l">${
          !profiles ? `<div class="skel" style="height:24px"></div>`
          : !isOk(profiles) ? `<p class="muted" style="padding:12px">${esc(profiles.error)}</p>`
          : profiles.map((x) => `<button class="${x.id === state.spId ? "on" : ""}" data-wf="pick-sp" data-id="${x.id}"><b>${esc(x.name)}</b><div class="muted">${(x.entries || []).length} shift(s)</div></button>`).join("") || empty("No staffing profiles yet.")
        }</div>
        <div class="split-r">
          ${!p ? empty("Select a staffing profile.") : `
          ${sec("Live fields", `<dl class="kv">
            <dt>Profile name</dt><dd>${esc(p.name)}</dd>
            <dt>Entries</dt><dd>${(p.entries || []).length} × shiftTemplateId + requiredHeadcount</dd>
            <dt>Required headcount</dt><dd>${(p.entries || []).reduce((s, e) => s + (e.requiredHeadcount || 0), 0)}</dd>
          </dl>
          <div class="cov" style="font-size:11px;color:var(--muted);letter-spacing:.05em;text-transform:uppercase"><span>Shift</span><span>Window</span><span>Break</span><span>Headcount</span></div>
          ${(p.entries || []).map((e) => {
            const t = templates.find((x) => x.id === e.shiftTemplateId);
            return `<div class="cov"><div><b>${esc(t ? t.name : e.shiftTemplateId)}</b></div><div class="mono">${t ? `${t.startTime}–${t.endTime}` : "—"}</div><div class="mono">${t ? `${t.breakMinutes}m` : "—"}</div><div class="mono">${e.requiredHeadcount}</div></div>`;
          }).join("") || `<p class="muted">No entries yet.</p>`}`)}
          <div class="actions">
            <button class="btn" data-wf="edit-sp" data-id="${p.id}">Edit</button>
            <button class="btn" data-wf="delete-sp" data-id="${p.id}">Delete</button>
          </div>`}
        </div>
      </div>`;
  } else if (spTab === "templates") {
    body = !isOk(state.wf.shiftTemplates)
      ? (state.wf.shiftTemplates && state.wf.shiftTemplates.error ? `<p class="muted">${esc(state.wf.shiftTemplates.error)}</p>` : `<div class="skel" style="height:24px"></div>`)
      : `<table class="data"><thead><tr><th>Name</th><th>Window</th><th>Break</th><th>Default headcount</th><th></th></tr></thead><tbody>${templates.map((t) => `<tr><td>${esc(t.name)}</td><td class="mono">${t.startTime}–${t.endTime}</td><td class="mono">${t.breakMinutes}m</td><td>${t.defaultHeadcount}</td><td><button class="btn btn-sm" data-wf="edit-template" data-id="${t.id}">Edit</button> <button class="btn btn-sm" data-wf="delete-template" data-id="${t.id}">Delete</button></td></tr>`).join("") || `<tr><td colspan="5" class="muted">No shift templates yet — create one before building a staffing profile.</td></tr>`}</tbody></table>`;
  } else {
    const patterns = state.wf.workPatterns;
    if (!patterns) loadWorkPatterns(state);
    body = !patterns ? `<div class="skel" style="height:24px"></div>`
      : !isOk(patterns) ? `<p class="muted">${esc(patterns.error)}</p>`
      : `<table class="data"><thead><tr><th>Name</th><th>Days</th><th></th></tr></thead><tbody>${patterns.map((wp) => `<tr><td>${esc(wp.name)}</td><td>${(wp.days || []).map((d) => d ? esc(templateName(d)) : "Off").join(" · ")}</td><td><button class="btn btn-sm" data-wf="delete-pattern" data-id="${wp.id}">Delete</button></td></tr>`).join("") || `<tr><td colspan="3" class="muted">No work patterns yet.</td></tr>`}</tbody></table>`;
  }

  return `
    ${pageHead("Staffing Profile", "Named coverage bundles from the Shifts library — wired to scheduling-service.", `
      ${spTab === "profiles" ? `<button class="btn btn-primary" data-wf="open-sp">+ Create profile</button>` : ""}
      ${spTab === "templates" ? `<button class="btn btn-primary" data-wf="open-template">+ Create shift template</button>` : ""}
      ${spTab === "patterns" ? `<button class="btn btn-primary" data-wf="open-pattern">+ Create work pattern</button>` : ""}
    `)}
    <div class="tabs">
      <button class="tab ${spTab === "profiles" ? "on" : ""}" data-wf="sp-subtab" data-id="profiles">Profiles</button>
      <button class="tab ${spTab === "templates" ? "on" : ""}" data-wf="sp-subtab" data-id="templates">Shift Templates</button>
      <button class="tab ${spTab === "patterns" ? "on" : ""}" data-wf="sp-subtab" data-id="patterns">Work Patterns</button>
    </div>
    ${body}`;
}

export function renderDrawer(state) {
  const d = state.drawer;
  const templates = isOk(state.wf.shiftTemplates) ? state.wf.shiftTemplates : [];
  if (d === "sp") {
    const editing = state.editSpTarget;
    const draftEntries = state.spDraftEntries || (editing ? editing.entries.map((e) => ({ ...e })) : []);
    state.spDraftEntries = draftEntries;
    if (state.spDraftName === undefined) state.spDraftName = (editing && editing.name) || "";
    return drawerShell(editing ? "Edit staffing profile" : "Create staffing profile", editing ? "Update this staffing profile." : "Define a new staffing profile.",
      `<div class="field"><label>Name</label><input id="sp-name" data-wf="sp-name-input" value="${esc(state.spDraftName)}" placeholder="e.g. Standard weekday" /></div>
       <div class="field" style="margin-top:10px"><label>Entries</label>
         ${draftEntries.map((e, i) => `<div class="cov" style="margin-bottom:6px">
           <select data-sp-entry-shift="${i}">${templates.map((t) => `<option value="${t.id}" ${e.shiftTemplateId === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select>
           <input type="number" min="0" data-sp-entry-hc="${i}" value="${e.requiredHeadcount ?? 1}" style="width:80px" />
           <button type="button" class="btn btn-sm" data-wf="sp-remove-entry" data-id="${i}">Remove</button>
         </div>`).join("") || `<p class="hint">No entries yet — add one below.</p>`}
         <button type="button" class="btn btn-sm" data-wf="sp-add-entry" ${templates.length ? "" : "disabled"}>+ Add shift entry</button>
         ${templates.length ? "" : `<p class="hint">Create a shift template first — see the Shift Templates tab.</p>`}
       </div>`,
      `<button class="btn" data-wf="close-drawer">Cancel</button>`,
      `<button class="btn btn-primary" data-wf="${editing ? "sp-edit-go" : "sp-go"}" ${editing ? `data-id="${editing.id}"` : ""} ${state.wf.saving.sp ? "disabled" : ""}>${state.wf.saving.sp ? "Saving…" : editing ? "Save" : "Create"}</button>`);
  }
  if (d === "template") {
    const editing = state.editTemplateTarget;
    return drawerShell(editing ? "Edit shift template" : "Create shift template", editing ? "Update this shift template." : "Define a new shift template.",
      `<div class="grid-2">
        <div class="field full"><label>Name</label><input id="st-name" value="${esc((editing && editing.name) || "")}" /></div>
        <div class="field"><label>Start time</label><input id="st-start" type="time" value="${(editing && editing.startTime) || "09:00"}" /></div>
        <div class="field"><label>End time</label><input id="st-end" type="time" value="${(editing && editing.endTime) || "17:00"}" /></div>
        <div class="field"><label>Break (minutes)</label><input id="st-break" type="number" min="0" value="${editing ? editing.breakMinutes : 30}" /></div>
        <div class="field"><label>Default headcount</label><input id="st-hc" type="number" min="1" value="${editing ? editing.defaultHeadcount : 1}" /></div>
      </div>`,
      `<button class="btn" data-wf="close-drawer">Cancel</button>`,
      `<button class="btn btn-primary" data-wf="${editing ? "template-edit-go" : "template-go"}" ${editing ? `data-id="${editing.id}"` : ""} ${state.wf.saving.template ? "disabled" : ""}>${state.wf.saving.template ? "Saving…" : editing ? "Save" : "Create"}</button>`);
  }
  if (d === "pattern") {
    const dayCount = state.patternDayCount || 7;
    const dayValues = state.patternDayValues || Array(dayCount).fill("");
    state.patternDayValues = dayValues;
    if (state.patternDraftName === undefined) state.patternDraftName = "";
    return drawerShell("Create work pattern", "Assign one shift template (or a day off) to each day of the pattern.",
      `<div class="field"><label>Name</label><input id="wp-name" data-wf="wp-name-input" value="${esc(state.patternDraftName)}" /></div>
       <div class="field" style="margin-top:10px"><label>Days (${dayCount})</label>
         ${dayValues.map((v, i) => `<div style="margin-bottom:6px"><span class="muted" style="display:inline-block;width:60px">Day ${i + 1}</span><select data-wf="wp-day-select" data-id="${i}"><option value="">Off</option>${templates.map((t) => `<option value="${t.id}" ${v === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>`).join("")}
         <button type="button" class="btn btn-sm" data-wf="wp-add-day" ${dayCount >= 28 ? "disabled" : ""}>+ Add day</button>
       </div>`,
      `<button class="btn" data-wf="close-drawer">Cancel</button>`,
      `<button class="btn btn-primary" data-wf="pattern-go" ${state.wf.saving.pattern ? "disabled" : ""}>${state.wf.saving.pattern ? "Creating…" : "Create"}</button>`);
  }
  return "";
}

export function handle(state, act, id, value) {
  const set = (k, v) => { state[k] = v; return true; };
  if (act === "sp-subtab") return set("staffingSubTab", id);
  if (act === "pick-sp") return set("spId", id);

  if (act === "open-sp") {
    state.editSpTarget = null;
    state.spDraftEntries = null;
    state.spDraftName = undefined;
    return set("drawer", "sp");
  }
  if (act === "edit-sp") {
    state.editSpTarget = (state.wf.staffingProfiles || []).find((p) => p.id === id);
    state.spDraftEntries = null;
    state.spDraftName = undefined;
    return set("drawer", "sp");
  }
  if (act === "sp-name-input") {
    state.spDraftName = value;
    return false;
  }
  if (act === "sp-add-entry") {
    const templates = isOk(state.wf.shiftTemplates) ? state.wf.shiftTemplates : [];
    if (!templates.length) return true;
    state.spDraftEntries = state.spDraftEntries || [];
    state.spDraftEntries.push({ shiftTemplateId: templates[0].id, requiredHeadcount: 1 });
    return true;
  }
  if (act === "sp-remove-entry") {
    state.spDraftEntries.splice(Number(id), 1);
    return true;
  }
  if (act === "sp-go" || act === "sp-edit-go") {
    const name = (state.spDraftName || $("#sp-name")?.value || "").trim();
    const entries = (state.spDraftEntries || []).map((_, i) => ({
      shiftTemplateId: document.querySelector(`[data-sp-entry-shift="${i}"]`)?.value,
      requiredHeadcount: Number(document.querySelector(`[data-sp-entry-hc="${i}"]`)?.value || 0),
    }));
    if (!name) {
      toast("Name is required.");
      return true;
    }
    state.wf.saving.sp = true;
    doRerender();
    const call = act === "sp-go"
      ? SchedulingApi.createStaffingProfile({ name, entries })
      : SchedulingApi.updateStaffingProfile(id, { name, entries });
    call
      .then(() => {
        state.wf.saving.sp = false;
        state.wf.staffingProfiles = null;
        state.spDraftEntries = null;
        state.drawer = null;
        toast("Staffing profile saved.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.sp = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "delete-sp") {
    if (!confirm("Delete this staffing profile?")) return true;
    SchedulingApi.deleteStaffingProfile(id)
      .then(() => {
        state.wf.staffingProfiles = null;
        state.spId = undefined;
        toast("Staffing profile deleted.");
        doRerender();
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }

  if (act === "open-template") {
    state.editTemplateTarget = null;
    return set("drawer", "template");
  }
  if (act === "edit-template") {
    state.editTemplateTarget = (state.wf.shiftTemplates || []).find((t) => t.id === id);
    return set("drawer", "template");
  }
  if (act === "template-go" || act === "template-edit-go") {
    const name = $("#st-name")?.value.trim();
    const startTime = $("#st-start")?.value;
    const endTime = $("#st-end")?.value;
    const breakMinutes = Number($("#st-break")?.value || 0);
    const defaultHeadcount = Number($("#st-hc")?.value || 1);
    if (!name || !startTime || !endTime) {
      toast("Name, start time, and end time are required.");
      return true;
    }
    state.wf.saving.template = true;
    doRerender();
    const call = act === "template-go"
      ? SchedulingApi.createShiftTemplate({ name, startTime, endTime, breakMinutes, defaultHeadcount })
      : SchedulingApi.updateShiftTemplate(id, { name, startTime, endTime, breakMinutes, defaultHeadcount });
    call
      .then(() => {
        state.wf.saving.template = false;
        state.wf.shiftTemplates = null;
        state.drawer = null;
        toast("Shift template saved.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.template = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "delete-template") {
    if (!confirm("Delete this shift template? Any staffing profile entries referencing it may break.")) return true;
    SchedulingApi.deleteShiftTemplate(id)
      .then(() => {
        state.wf.shiftTemplates = null;
        toast("Shift template deleted.");
        doRerender();
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }

  if (act === "open-pattern") {
    state.patternDayCount = 7;
    state.patternDayValues = null;
    state.patternDraftName = undefined;
    return set("drawer", "pattern");
  }
  if (act === "wp-add-day") {
    state.patternDayValues = state.patternDayValues || Array(state.patternDayCount || 7).fill("");
    state.patternDayValues.push("");
    state.patternDayCount = state.patternDayValues.length;
    return true;
  }
  if (act === "wp-day-select") {
    state.patternDayValues[Number(id)] = value || "";
    return false;
  }
  if (act === "wp-name-input") {
    state.patternDraftName = value;
    return false;
  }
  if (act === "pattern-go") {
    const name = (state.patternDraftName || $("#wp-name")?.value || "").trim();
    const count = state.patternDayCount || 7;
    const days = Array.from({ length: count }, (_, i) => state.patternDayValues[i] || null);
    if (!name) {
      toast("Name is required.");
      return true;
    }
    state.wf.saving.pattern = true;
    doRerender();
    SchedulingApi.createWorkPattern({ name, days })
      .then(() => {
        state.wf.saving.pattern = false;
        state.wf.workPatterns = null;
        state.patternDayValues = null;
        state.drawer = null;
        toast("Work pattern created.");
        doRerender();
      })
      .catch((err) => {
        state.wf.saving.pattern = false;
        toast(errMsg(err));
        doRerender();
      });
    return true;
  }
  if (act === "delete-pattern") {
    if (!confirm("Delete this work pattern?")) return true;
    SchedulingApi.deleteWorkPattern(id)
      .then(() => {
        state.wf.workPatterns = null;
        toast("Work pattern deleted.");
        doRerender();
      })
      .catch((err) => toast(errMsg(err)));
    return true;
  }
  return false;
}
